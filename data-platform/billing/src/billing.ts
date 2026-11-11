import { createHash, randomInt } from "node:crypto";
import pg from "pg";
import { migrations } from "./migrations.ts";

/** Every Moonshot Wallet starts with $100,000 the first time it is used. */
export const WALLET_STARTING_BALANCE_MINOR = 10_000_000;

export type Money = { amountMinor: number; currency: string };
export type InvoiceLine = { description: string; quantity: number; unitPrice: Money };

export type ChargeRequest = {
  /** The reservation being paid for. One charge per reservation: a repeat returns the original charge. */
  reservationId: string;
  walletId: string;
  billedTo: string;
  lines: InvoiceLine[];
};

export type Charge = {
  paymentId: string;
  invoiceNumber: string;
  walletLast4: string;
  amount: Money;
  balanceAfter: Money;
  paidAt: string;
};

export type Invoice = {
  invoiceNumber: string;
  issuedAt: string;
  reservationId: string;
  billedTo: string;
  lines: (InvoiceLine & { amount: Money })[];
  total: Money;
  payment: { method: "MOONSHOT_WALLET"; paymentId: string; walletLast4: string; paidAt: string };
};

/** A charge or lookup that billing refuses. The caller can show `message` to the guest. */
export class BillingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Standard Luhn check over the wallet's eight digits; the last digit is the check digit. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Parses `MSW-####-####`. Only a hash and the last four digits are ever stored. */
export function parseWalletId(input: string): { key: string; last4: string } {
  const match = /^MSW-(\d{4})-(\d{4})$/.exec(input.trim().toUpperCase());
  const digits = match ? match[1]! + match[2]! : "";
  if (!match || !luhnValid(digits)) {
    throw new BillingError(422, "WALLET_INVALID", "Check your Moonshot Wallet ID. It looks like MSW-1234-5678.");
  }
  return { key: createHash("sha256").update(`moonshot-wallet:${digits}`).digest("hex"), last4: digits.slice(4) };
}

type PaymentRow = {
  payment_id: string;
  reservation_id: string;
  request_fingerprint: string;
  wallet_last4: string;
  amount_minor: string;
  balance_after_minor: string;
  currency: string;
  invoice_number: string;
  created_at: Date;
};

type InvoiceRow = {
  invoice_number: string;
  reservation_id: string;
  billed_to: string;
  lines: InvoiceLine[];
  total_minor: string;
  currency: string;
  issued_at: Date;
  payment_id: string;
  wallet_last4: string;
  paid_at: Date;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const idAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const randomId = (length: number) => Array.from({ length }, () => idAlphabet[randomInt(idAlphabet.length)]).join("");

function toCharge(row: PaymentRow): Charge {
  return {
    paymentId: row.payment_id,
    invoiceNumber: row.invoice_number,
    walletLast4: row.wallet_last4.trim(),
    amount: { amountMinor: Number(row.amount_minor), currency: row.currency.trim() },
    balanceAfter: { amountMinor: Number(row.balance_after_minor), currency: row.currency.trim() },
    paidAt: row.created_at.toISOString(),
  };
}

const PAYMENT_SELECT = `
  SELECT p.*, i.invoice_number FROM billing.payments p
  JOIN billing.invoices i ON i.payment_id = p.payment_id
  WHERE p.reservation_id = $1`;

/** Receives billing's log lines. `details` never holds a wallet ID, a name or an amount; `reference` is the reservation. */
export type Log = (message: string, details: object) => void;

export class Billing {
  readonly #pool: pg.Pool;
  readonly #log: Log;

  constructor(pool: pg.Pool, log: Log = () => undefined) {
    this.#pool = pool;
    this.#log = log;
  }

  /** Creates the billing schema and applies pending migrations. Safe to run on every cold start. */
  async migrate(): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('billing-migrations'))");
      const schema = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'billing'");
      if (schema.rowCount === 0) await client.query("CREATE SCHEMA billing");
      await client.query("CREATE TABLE IF NOT EXISTS billing.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const applied = new Set((await client.query<{ version: string }>("SELECT version FROM billing.schema_migrations")).rows.map(row => row.version));
      const pending = migrations.filter(migration => !applied.has(migration.version));
      for (const migration of pending) {
        await client.query(migration.sql);
        await client.query("INSERT INTO billing.schema_migrations (version) VALUES ($1)", [migration.version]);
      }
      await client.query("COMMIT");
      for (const { version } of pending) this.#log("Migration applied", { version });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Charges the wallet and issues the invoice in one transaction. A new wallet starts with $100,000.
   * Charging the same reservation again returns the original charge; a different charge for it is refused.
   */
  async charge(request: ChargeRequest): Promise<Charge> {
    const wallet = parseWalletId(request.walletId);
    const currency = request.lines[0]!.unitPrice.currency;
    if (request.lines.some(line => line.unitPrice.currency !== currency)) {
      throw new BillingError(400, "INVALID_REQUEST", "Every invoice line must use the same currency.");
    }
    const total = request.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice.amountMinor, 0);
    const fingerprint = sha256(JSON.stringify([wallet.key, request.billedTo, request.lines]));

    const replay = await this.#replay(request.reservationId, fingerprint);
    if (replay) return replay;

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const opened = await client.query(
        `INSERT INTO billing.wallets (wallet_key, wallet_last4, balance_minor, currency) VALUES ($1, $2, $3, $4)
         ON CONFLICT (wallet_key) DO NOTHING`,
        [wallet.key, wallet.last4, WALLET_STARTING_BALANCE_MINOR, currency],
      );
      const debited = await client.query<{ balance_minor: string }>(
        `UPDATE billing.wallets SET balance_minor = balance_minor - $2, updated_at = now()
         WHERE wallet_key = $1 AND currency = $3 AND balance_minor >= $2 RETURNING balance_minor`,
        [wallet.key, total, currency],
      );
      const balanceAfter = debited.rows[0]?.balance_minor;
      if (balanceAfter === undefined) {
        throw new BillingError(409, "INSUFFICIENT_FUNDS", "Your Moonshot Wallet does not have enough balance for this reservation.");
      }

      const paymentId = `PAY-${randomId(10)}`;
      const inserted = await client.query(
        `INSERT INTO billing.payments (payment_id, reservation_id, request_fingerprint, wallet_key, wallet_last4, amount_minor,
           balance_after_minor, currency)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (reservation_id) DO NOTHING`,
        [paymentId, request.reservationId, fingerprint, wallet.key, wallet.last4, total, balanceAfter, currency],
      );
      if (inserted.rowCount === 0) {
        // A concurrent charge for the same reservation won; undo this debit and return that charge.
        await client.query("ROLLBACK");
        const concurrent = await this.#replay(request.reservationId, fingerprint);
        if (!concurrent) throw new Error("Charge conflict could not be resolved.");
        return concurrent;
      }
      await client.query(
        `INSERT INTO billing.invoices (invoice_number, payment_id, reservation_id, billed_to, lines, total_minor, currency)
         VALUES ('INV-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('billing.invoice_number')::text, 6, '0'),
           $1, $2, $3, $4, $5, $6)`,
        [paymentId, request.reservationId, request.billedTo, JSON.stringify(request.lines), total, currency],
      );
      const charged = await client.query<PaymentRow>(PAYMENT_SELECT, [request.reservationId]);
      await client.query("COMMIT");
      const charge = toCharge(charged.rows[0]!);
      if (opened.rowCount === 1) this.#log("Wallet opened", { reference: request.reservationId });
      this.#log("Wallet charged", { reference: request.reservationId, paymentId: charge.paymentId, invoiceNumber: charge.invoiceNumber });
      return charge;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async invoice(invoiceNumber: string): Promise<Invoice> {
    const result = await this.#pool.query<InvoiceRow>(
      `SELECT i.*, p.wallet_last4, p.created_at AS paid_at FROM billing.invoices i
       JOIN billing.payments p ON p.payment_id = i.payment_id WHERE i.invoice_number = $1`,
      [invoiceNumber],
    );
    const row = result.rows[0];
    if (!row) throw new BillingError(404, "INVOICE_NOT_FOUND", "We could not find that invoice.");
    const currency = row.currency.trim();
    return {
      invoiceNumber: row.invoice_number,
      issuedAt: row.issued_at.toISOString(),
      reservationId: row.reservation_id,
      billedTo: row.billed_to,
      lines: row.lines.map(line => ({ ...line, amount: { amountMinor: line.quantity * line.unitPrice.amountMinor, currency } })),
      total: { amountMinor: Number(row.total_minor), currency },
      payment: { method: "MOONSHOT_WALLET", paymentId: row.payment_id, walletLast4: row.wallet_last4.trim(), paidAt: row.paid_at.toISOString() },
    };
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #replay(reservationId: string, fingerprint: string): Promise<Charge | undefined> {
    const result = await this.#pool.query<PaymentRow>(PAYMENT_SELECT, [reservationId]);
    const row = result.rows[0];
    if (!row) return undefined;
    if (row.request_fingerprint !== fingerprint) {
      throw new BillingError(409, "PAYMENT_MISMATCH", "This reservation was already paid with different details.");
    }
    const charge = toCharge(row);
    this.#log("Charge replayed", { reference: reservationId, paymentId: charge.paymentId, invoiceNumber: charge.invoiceNumber });
    return charge;
  }
}
