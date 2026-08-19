ALTER TABLE orchestration_runs
  ADD COLUMN IF NOT EXISTS contract_provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_durable_activity_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS last_durable_activity_type text,
  ADD COLUMN IF NOT EXISTS last_durable_activity_sequence bigint