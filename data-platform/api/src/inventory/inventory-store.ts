import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { OfferTerms, PassDetails, Reservation, ReservationRequest, StockLevel } from "../domain.ts";
import { conflict, notFound, unprocessable } from "../errors.ts";

type TermsRow = {
  offer_id: string;
  unit_price_minor: number;
  currency: string;
  allocation: number;
  max_per_reservation: number;
  sales_open_at: Date;
  sales_close_at: Date;
};

type ReservationRow = {
  confirmation_code: string;
  idempotency_key: string;
  request_fingerprint: string;
  offer_id: string;
  lead_name: string;
  quantity: number;
  unit_price_minor: number;
  currency: string;
  total_minor: number;
  pass: PassDetails;
  access_key_hash: string;
  created_at: Date;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const codeAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomCode = (length: number) => Array.from({ length }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join("");

function toReservation(row: ReservationRow): Reservation {
  return {
    confirmationCode: row.confirmation_code,
    leadName: row.lead_name,
    offerId: row.offer_id,
    quantity: row.quantity,
    unitPrice: { amountMinor: row.unit_price_minor, currency: row.currency },
    total: { amountMinor: row.total_minor, currency: row.currency },
    pass: row.pass,
    status: "CONFIRMED",
    createdAt: row.created_at.toISOString(),
  };
}

function toTerms(row: TermsRow): OfferTerms {
  return {
    offerId: row.offer_id,
    unitPrice: { amountMinor: row.unit_price_minor, currency: row.currency },
    maxPerReservation: row.max_per_reservation,
    salesOpenAt: row.sales_open_at.toISOString(),
    salesCloseAt: row.sales_close_at.toISOString(),
  };
}

export class InventoryStore {
  readonly #pool: pg.Pool;

  constructor(connectionString: string, maxConnections = 10) {
    this.#pool = new pg.Pool({ connectionString, max: maxConnections });
  }

  async migrate(directory: string): Promise<void> {
    await this.#pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const files = (await readdir(directory)).filter(file => file.endsWith(".sql")).sort();
    for (const file of files) {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
        const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
        if (applied.rowCount === 0) {
          await client.query(await readFile(join(directory, file), "utf8"));
          await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  }

  async seed(rows: (OfferTerms & { allocation: number })[]): Promise<void> {
    for (const row of rows) {
      await this.#pool.query(
        `INSERT INTO offer_inventory (offer_id, unit_price_minor, currency, allocation, max_per_reservation, sales_open_at, sales_close_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (offer_id) DO NOTHING`,
        [row.offerId, row.unitPrice.amountMinor, row.unitPrice.currency, row.allocation, row.maxPerReservation, row.salesOpenAt, row.salesCloseAt],
      );
    }
  }

  async stockLevels(offerIds: string[]): Promise<StockLevel[]> {
    const result = await this.#pool.query<TermsRow & { reserved: string }>(
      `SELECT i.*, COALESCE((SELECT SUM(r.quantity) FROM reservations r WHERE r.offer_id = i.offer_id), 0) AS reserved
       FROM offer_inventory i WHERE i.offer_id = ANY($1)`,
      [offerIds],
    );
    const asOf = new Date().toISOString();
    return result.rows.map(row => ({ ...toTerms(row), remaining: row.allocation - Number(row.reserved), asOf }));
  }

  async reserve(request: ReservationRequest, idempotencyKey: string, pass: PassDetails): Promise<Reservation> {
    const accessKeyHash = sha256(request.accessKey);
    const fingerprint = sha256(JSON.stringify([
      request.offerId, request.leadName, request.quantity,
      request.expectedUnitPrice.amountMinor, request.expectedUnitPrice.currency, accessKeyHash,
    ]));

    const replay = await this.#replay(idempotencyKey, fingerprint);
    if (replay) return replay;

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const termsResult = await client.query<TermsRow>("SELECT * FROM offer_inventory WHERE offer_id = $1 FOR UPDATE", [request.offerId]);
      const terms = termsResult.rows[0];
      if (!terms) throw notFound("OFFER_NOT_FOUND", "This pass does not exist.");

      const now = new Date();
      if (request.quantity > terms.max_per_reservation) {
        throw unprocessable("QUANTITY_NOT_ALLOWED", `You can reserve up to ${terms.max_per_reservation} passes at a time.`);
      }
      if (now < terms.sales_open_at || now >= terms.sales_close_at) {
        throw conflict("NOT_ON_SALE", "This pass is not on sale right now.");
      }
      if (request.expectedUnitPrice.amountMinor !== terms.unit_price_minor || request.expectedUnitPrice.currency !== terms.currency.trim()) {
        throw conflict("PRICE_CHANGED", "The price of this pass has changed. Review the new price before reserving.");
      }

      const reserved = await client.query<{ reserved: string }>(
        "SELECT COALESCE(SUM(quantity), 0) AS reserved FROM reservations WHERE offer_id = $1",
        [request.offerId],
      );
      if (terms.allocation - Number(reserved.rows[0]?.reserved ?? 0) < request.quantity) {
        throw conflict("INSUFFICIENT_STOCK", "There are not enough passes left for this reservation.");
      }

      const inserted = await client.query<ReservationRow>(
        `INSERT INTO reservations (confirmation_code, idempotency_key, request_fingerprint, offer_id, lead_name, quantity,
           unit_price_minor, currency, total_minor, pass, access_key_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [
          `MSF-${randomCode(4)}-${randomCode(4)}`, idempotencyKey, fingerprint, request.offerId, request.leadName,
          request.quantity, terms.unit_price_minor, terms.currency.trim(), terms.unit_price_minor * request.quantity,
          JSON.stringify(pass), accessKeyHash,
        ],
      );
      await client.query("COMMIT");

      const row = inserted.rows[0];
      if (row) return toReservation(row);
      const concurrent = await this.#replay(idempotencyKey, fingerprint);
      if (!concurrent) throw new Error("Reservation conflict could not be resolved.");
      return concurrent;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async findReservation(confirmationCode: string, accessKey: string): Promise<Reservation> {
    const result = await this.#pool.query<ReservationRow>("SELECT * FROM reservations WHERE confirmation_code = $1", [confirmationCode]);
    const row = result.rows[0];
    const presented = Buffer.from(sha256(accessKey));
    if (!row || !timingSafeEqual(presented, Buffer.from(row.access_key_hash))) {
      throw notFound("RESERVATION_NOT_FOUND", "We could not find that reservation.");
    }
    return toReservation(row);
  }

  async ping(): Promise<void> {
    await this.#pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #replay(idempotencyKey: string, fingerprint: string): Promise<Reservation | undefined> {
    const result = await this.#pool.query<ReservationRow>("SELECT * FROM reservations WHERE idempotency_key = $1", [idempotencyKey]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.request_fingerprint !== fingerprint) {
      throw unprocessable("IDEMPOTENCY_KEY_REUSED", "This request key was already used for a different reservation.");
    }
    return toReservation(row);
  }
}
