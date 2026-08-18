CREATE TABLE IF NOT EXISTS work_lease_checkpoints (
  checkpoint_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL REFERENCES work_leases(lease_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL,
  checkpoint jsonb NOT NULL,
  checkpoint_sha256 text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (lease_id, idempotency_key)
)