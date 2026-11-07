-- Moonshot Wallets: any well-formed wallet starts with a balance the first time it is used and is
-- debited in the same transaction as the reservation it pays for.
CREATE TABLE IF NOT EXISTS wallets (
  wallet_key     text PRIMARY KEY,
  wallet_last4   char(4) NOT NULL,
  balance_minor  bigint NOT NULL CHECK (balance_minor >= 0),
  currency       char(3) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS admission_entry_id  text UNIQUE,
  ADD COLUMN IF NOT EXISTS wallet_last4        char(4),
  ADD COLUMN IF NOT EXISTS paid_minor          bigint,
  ADD COLUMN IF NOT EXISTS balance_after_minor bigint;

CREATE TABLE IF NOT EXISTS wallet_transactions (
  transaction_id     text PRIMARY KEY,
  wallet_key         text NOT NULL REFERENCES wallets (wallet_key),
  confirmation_code  text NOT NULL REFERENCES reservations (confirmation_code),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  balance_after      bigint NOT NULL CHECK (balance_after >= 0),
  currency           char(3) NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wallet_transactions_wallet ON wallet_transactions (wallet_key, created_at);
