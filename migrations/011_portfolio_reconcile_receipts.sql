CREATE TABLE IF NOT EXISTS portfolio_reconcile_receipts (
  idempotency_key text PRIMARY KEY,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('processing','succeeded')),
  attempt_token uuid NOT NULL,
  receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
)