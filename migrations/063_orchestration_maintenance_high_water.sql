CREATE TABLE IF NOT EXISTS orchestration_maintenance_high_water (
  maintenance_key text PRIMARY KEY,
  authoritative_revision text NOT NULL CHECK (authoritative_revision ~ '^[0-9a-f]{40}$'),
  timed_maintenance_epoch timestamptz NOT NULL,
  maintained_at timestamptz NOT NULL
);
