CREATE TABLE IF NOT EXISTS work_lease_slots (
  work_ref text NOT NULL,
  gate text NOT NULL,
  lease_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_ref, gate)
)