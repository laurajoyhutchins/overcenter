ALTER TABLE orchestration_runs
  ADD COLUMN IF NOT EXISTS skill_policy jsonb NOT NULL DEFAULT '{}'::jsonb;