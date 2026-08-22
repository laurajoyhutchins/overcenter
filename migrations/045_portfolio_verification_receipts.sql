CREATE TABLE IF NOT EXISTS portfolio_verification_receipts (
  predicate_key text PRIMARY KEY,
  work_ref text NOT NULL,
  predicate_kind text NOT NULL,
  satisfied_at timestamptz NOT NULL DEFAULT now(),
  evidence_sha256 text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
)