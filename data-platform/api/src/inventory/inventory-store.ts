import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import type { OfferTerms, PassDetails, Reservation, ReservationRequest, StockLevel } from "../domain.ts";
import { conflict, notFound, unprocessable } from "../errors.ts";
import { parseWalletId, WALLET_STARTING_BALANCE_MINOR } from "../wallet.ts";

/**
 * With a token callback, settings come from the URL's parts: node-postgres re-parses a
 * `connectionString` and would replace the callback with the URL's empty password.
 */
export function poolConfig(connectionString: string, max: number, password?: () => Promise<string>, ca?: string): pg.PoolConfig {
  if (!password) return { connectionString, max };
  const url = new URL(connectionString);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password,
    ssl: url.searchParams.get("sslmode") === "disable" ? false : { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max,
  };
}

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
  admission_entry_id: string | null;
  wallet_last4: string | null;
  paid_minor: string | null;
  balance_after_minor: string | null;
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
    ...(row.wallet_last4 && row.paid_minor !== null && row.balance_after_minor !== null
      ? {
        payment: {
          method: "MOONSHOT_WALLET" as const,
          walletLast4: row.wallet_last4,
          amount: { amountMinor: Number(row.paid_minor), currency: row.currency },
          balanceAfter: { amountMinor: Number(row.balance_after_minor), currency: row.currency },
        },
      }
      : {}),
    createdAt: row.created_at.toISOString(),
  };
}

const isUniqueViolation = (error: unknown, constraint: string) =>
  (error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === constraint;

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

  /**
   * `password` supplies a fresh token per connection in Azure (Microsoft Entra or AWS RDS IAM);
   * locally the URL carries the password. `ca` adds trusted roots, such as the Amazon RDS bundle.
   */
  constructor(connectionString: string, maxConnections = 10, password?: () => Promise<string>, ca?: string) {
    this.#pool = new pg.Pool(poolConfig(connectionString, maxConnections, password, ca));
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

  /** True when a reservation already exists for this idempotency key (a retry). */
  async hasReservation(idempotencyKey: string): Promise<boolean> {
    const result = await this.#pool.query("SELECT 1 FROM reservations WHERE idempotency_key = $1", [idempotencyKey]);
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Reserves passes and pays for them with a Moonshot Wallet in one transaction: stock, sale window,
   * price and wallet balance are checked together, so nothing is reserved without being paid for.
   */
  async reserve(request: ReservationRequest, idempotencyKey: string, pass: PassDetails, admissionEntryId: string): Promise<Reservation> {
    const accessKeyHash = sha256(request.accessKey);
    const wallet = parseWalletId(request.walletId);
    const fingerprint = sha256(JSON.stringify([
      request.offerId, request.leadName, request.quantity,
      request.expectedUnitPrice.amountMinor, request.expectedUnitPrice.currency, accessKeyHash, wallet.key, admissionEntryId,
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

      const currency = terms.currency.trim();
      const total = terms.unit_price_minor * request.quantity;
      await client.query(
        `INSERT INTO wallets (wallet_key, wallet_last4, balance_minor, currency) VALUES ($1, $2, $3, $4)
         ON CONFLICT (wallet_key) DO NOTHING`,
        [wallet.key, wallet.last4, WALLET_STARTING_BALANCE_MINOR, currency],
      );
      const debited = await client.query<{ balance_minor: string }>(
        `UPDATE wallets SET balance_minor = balance_minor - $2, updated_at = now()
         WHERE wallet_key = $1 AND currency = $3 AND balance_minor >= $2 RETURNING balance_minor`,
        [wallet.key, total, currency],
      );
      const balanceAfter = debited.rows[0]?.balance_minor;
      if (balanceAfter === undefined) {
        throw conflict("INSUFFICIENT_FUNDS", "Your Moonshot Wallet does not have enough balance for this reservation.");
      }

      const confirmationCode = `MSF-${randomCode(4)}-${randomCode(4)}`;
      const inserted = await client.query<ReservationRow>(
        `INSERT INTO reservations (confirmation_code, idempotency_key, request_fingerprint, offer_id, lead_name, quantity,
           unit_price_minor, currency, total_minor, pass, access_key_hash, admission_entry_id, wallet_last4, paid_minor,
           balance_after_minor)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [
          confirmationCode, idempotencyKey, fingerprint, request.offerId, request.leadName, request.quantity,
          terms.unit_price_minor, currency, total, JSON.stringify(pass), accessKeyHash, admissionEntryId, wallet.last4,
          total, balanceAfter,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        // A concurrent retry with the same key won; undo this debit and return its reservation.
        await client.query("ROLLBACK");
        const concurrent = await this.#replay(idempotencyKey, fingerprint);
        if (!concurrent) throw new Error("Reservation conflict could not be resolved.");
        return concurrent;
      }
      await client.query(
        `INSERT INTO wallet_transactions (transaction_id, wallet_key, confirmation_code, amount_minor, balance_after, currency)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [`TXN-${randomCode(10)}`, wallet.key, confirmationCode, total, balanceAfter, currency],
      );
      await client.query("COMMIT");
      return toReservation(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(error, "reservations_admission_entry_id_key")) {
        throw conflict("ADMISSION_USED", "This place in line was already used for a reservation.");
      }
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

  /** Whether this connection's user can sign in and create tables in the public schema (needed for migrations). */
  async canCreateTables(): Promise<boolean> {
    const { rows } = await this.#pool.query<{ allowed: boolean }>("SELECT has_schema_privilege('public', 'CREATE') AS allowed");
    return rows[0]?.allowed === true;
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
