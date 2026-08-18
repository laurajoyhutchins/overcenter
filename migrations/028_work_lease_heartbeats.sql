CREATE TABLE work_lease_heartbeats (
  heartbeat_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL,
  progress_sha256 text NOT NULL,
  previous_expires_at timestamptz NOT NULL,
  new_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lease_id, idempotency_key)
)