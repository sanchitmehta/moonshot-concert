/**
 * Billing's schema, applied in order by `Billing.migrate()` on cold start. Kept in code so the Lambda
 * bundle is a single file. Never edit an applied migration; add a new one.
 */
export const migrations: { version: string; sql: string }[] = [
  {
    version: "001_wallets_payments_invoices",
    sql: `
      CREATE TABLE billing.wallets (
        wallet_key     text PRIMARY KEY,
        wallet_last4   char(4) NOT NULL,
        balance_minor  bigint NOT NULL CHECK (balance_minor >= 0),
        currency       char(3) NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        updated_at     timestamptz NOT NULL DEFAULT now()
      );

      -- One payment per reservation; the fingerprint detects a different charge for the same reservation.
      CREATE TABLE billing.payments (
        payment_id           text PRIMARY KEY,
        reservation_id       text NOT NULL UNIQUE,
        request_fingerprint  text NOT NULL,
        wallet_key           text NOT NULL REFERENCES billing.wallets (wallet_key),
        wallet_last4         char(4) NOT NULL,
        amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
        balance_after_minor  bigint NOT NULL CHECK (balance_after_minor >= 0),
        currency             char(3) NOT NULL,
        created_at           timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX payments_wallet ON billing.payments (wallet_key, created_at);

      CREATE SEQUENCE billing.invoice_number;
      CREATE TABLE billing.invoices (
        invoice_number  text PRIMARY KEY,
        payment_id      text NOT NULL UNIQUE REFERENCES billing.payments (payment_id),
        reservation_id  text NOT NULL,
        billed_to       text NOT NULL,
        lines           jsonb NOT NULL,
        total_minor     bigint NOT NULL,
        currency        char(3) NOT NULL,
        issued_at       timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];
