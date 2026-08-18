CREATE TABLE orchestration_horizons (
  horizon_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL,
  generation integer NOT NULL,
  candidates jsonb NOT NULL,
  horizon_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, generation)
)