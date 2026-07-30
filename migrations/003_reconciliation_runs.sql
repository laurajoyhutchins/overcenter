CREATE TABLE portfolio_reconciliation_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode = 'shadow'),
  outcome text NOT NULL CHECK (outcome IN ('started','completed','failed')),
  requested_entity_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(requested_entity_keys) = 'array'),
  input_watermark timestamptz,
  source_observation_count integer NOT NULL DEFAULT 0 CHECK (source_observation_count >= 0),
  affected_entity_count integer NOT NULL DEFAULT 0 CHECK (affected_entity_count >= 0),
  projection_count integer NOT NULL DEFAULT 0 CHECK (projection_count >= 0),
  discrepancy_count integer NOT NULL DEFAULT 0 CHECK (discrepancy_count >= 0),
  output_digest text CHECK (output_digest IS NULL OR output_digest ~ '^[0-9a-f]{64}$'),
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
)