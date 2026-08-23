CREATE TABLE IF NOT EXISTS orchestration_skill_activations (
  activation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id text NOT NULL REFERENCES orchestration_runs(run_id) ON DELETE CASCADE,
  skill_name text NOT NULL,
  skill_revision text NOT NULL,
  skill_reference text NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','failed','canceled')),
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  completion_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (run_id, skill_name)
);

CREATE INDEX IF NOT EXISTS orchestration_skill_activations_run_idx
  ON orchestration_skill_activations(run_id, created_at);