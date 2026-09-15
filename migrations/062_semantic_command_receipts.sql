CREATE TABLE IF NOT EXISTS semantic_command_receipts (
  request_id TEXT PRIMARY KEY,
  receipt_ref TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  source_revision TEXT NOT NULL CHECK (source_revision ~ '^[0-9a-f]{40}$'),
  request_sha256 TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 TEXT NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_sha256 TEXT NOT NULL CHECK (receipt_sha256 ~ '^[0-9a-f]{64}$'),
  receipt JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS semantic_command_receipts_source_revision_idx
  ON semantic_command_receipts (source_revision, created_at DESC);
