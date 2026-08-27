ALTER TABLE orchestration_runs
  ADD COLUMN IF NOT EXISTS target jsonb,
  ADD COLUMN IF NOT EXISTS target_sha256 text,
  ADD COLUMN IF NOT EXISTS base_start_request_sha256 text;

ALTER TABLE orchestration_runs
  DROP CONSTRAINT IF EXISTS orchestration_runs_target_identity_check;
ALTER TABLE orchestration_runs
  ADD CONSTRAINT orchestration_runs_target_identity_check CHECK (
    (target IS NULL AND target_sha256 IS NULL AND base_start_request_sha256 IS NULL)
    OR
    (jsonb_typeof(target) = 'object' AND target_sha256 ~ '^[0-9a-f]{64}$' AND base_start_request_sha256 ~ '^[0-9a-f]{64}$')
  );

CREATE INDEX IF NOT EXISTS orchestration_runs_target_continuation_idx
  ON orchestration_runs (continuation_key, scope_sha256, target_sha256, started_at DESC);