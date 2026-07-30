CREATE TABLE portfolio_observations (
  observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  source_system text NOT NULL CHECK (source_system ~ '^[a-z][a-z0-9_-]{0,63}$'),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  entity_key text NOT NULL CHECK (length(entity_key) BETWEEN 1 AND 512),
  fact_type text NOT NULL CHECK (fact_type ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  observed_at timestamptz NOT NULL,
  source_revision text NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 512),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  payload_canonical text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  ingestion_source text NOT NULL CHECK (length(ingestion_source) BETWEEN 1 AND 128),
  ingestion_run_id text,
  created_at timestamptz NOT NULL DEFAULT now()
)