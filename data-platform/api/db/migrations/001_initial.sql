CREATE TABLE IF NOT EXISTS offer_inventory (
  offer_id            text PRIMARY KEY,
  unit_price_minor    integer NOT NULL CHECK (unit_price_minor >= 0),
  currency            char(3) NOT NULL,
  allocation          integer NOT NULL CHECK (allocation >= 0),
  max_per_reservation integer NOT NULL CHECK (max_per_reservation BETWEEN 1 AND 6),
  sales_open_at       timestamptz NOT NULL,
  sales_close_at      timestamptz NOT NULL,
  CHECK (sales_close_at > sales_open_at)
);

CREATE TABLE IF NOT EXISTS reservations (
  confirmation_code   text PRIMARY KEY,
  idempotency_key     text NOT NULL UNIQUE,
  request_fingerprint text NOT NULL,
  offer_id            text NOT NULL REFERENCES offer_inventory (offer_id),
  lead_name           text NOT NULL,
  quantity            integer NOT NULL CHECK (quantity BETWEEN 1 AND 6),
  unit_price_minor    integer NOT NULL,
  currency            char(3) NOT NULL,
  total_minor         integer NOT NULL,
  pass                jsonb NOT NULL,
  access_key_hash     text NOT NULL,
  status              text NOT NULL DEFAULT 'CONFIRMED',
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Remaining stock is calculated from reservations; the index keeps that sum index-only.
CREATE INDEX IF NOT EXISTS reservations_offer_quantity ON reservations (offer_id) INCLUDE (quantity);
