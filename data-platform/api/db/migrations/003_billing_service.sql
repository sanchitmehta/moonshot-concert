-- Moonshot Billing (fn-moonshot-billing, AWS Lambda) now charges wallets and issues invoices in its own
-- `billing` schema. A reservation holds its passes as PENDING_PAYMENT until billing confirms the
-- payment; a refused payment cancels it, returns the passes to stock and releases the admission.
ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS payment_id      text,
  ADD COLUMN IF NOT EXISTS invoice_number  text,
  ADD COLUMN IF NOT EXISTS failure_status  integer,
  ADD COLUMN IF NOT EXISTS failure_code    text,
  ADD COLUMN IF NOT EXISTS failure_message text;

ALTER TABLE reservations ADD CONSTRAINT reservations_status_valid
  CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELLED')) NOT VALID;

-- Remaining stock counts every reservation that is not cancelled.
DROP INDEX IF EXISTS reservations_offer_quantity;
CREATE INDEX IF NOT EXISTS reservations_offer_held ON reservations (offer_id) INCLUDE (quantity) WHERE status <> 'CANCELLED';

-- Retired: wallets moved to billing. Kept until the previous API version can no longer be rolled back to.
COMMENT ON TABLE wallets IS 'Retired: Moonshot Wallets are kept by billing (schema billing). Drop in a later migration.';
COMMENT ON TABLE wallet_transactions IS 'Retired: payments are kept by billing (schema billing). Drop in a later migration.';
