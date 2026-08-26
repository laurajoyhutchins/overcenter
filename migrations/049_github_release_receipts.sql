CREATE TABLE IF NOT EXISTS github_release_receipts (
  repo TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  request_json JSONB NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing','partial','succeeded')),
  attempt_token UUID NOT NULL,
  target_sha TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  tag_created BOOLEAN NOT NULL DEFAULT FALSE,
  tag_ref_node_id TEXT,
  release_id BIGINT,
  receipt JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo,idempotency_key)
);
CREATE INDEX IF NOT EXISTS github_release_receipts_state_idx ON github_release_receipts (state,updated_at);