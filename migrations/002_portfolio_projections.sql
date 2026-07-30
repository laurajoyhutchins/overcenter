CREATE TABLE portfolio_entity_projections (
  entity_key text PRIMARY KEY,
  entity_type text NOT NULL,
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  projection_sha256 text NOT NULL CHECK (projection_sha256 ~ '^[0-9a-f]{64}$'),
  reducer_version text NOT NULL,
  input_watermark timestamptz,
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
)