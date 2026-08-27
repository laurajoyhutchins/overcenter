CREATE TABLE IF NOT EXISTS github_production_promotion_receipts (
  repo text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL,
  request_json jsonb NOT NULL,
  state text NOT NULL,
  attempt_token uuid,
  candidate_sha text NOT NULL,
  old_production_head text NOT NULL,
  new_production_head text,
  verification_run_id bigint NOT NULL,
  receipt jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo, idempotency_key)
)
