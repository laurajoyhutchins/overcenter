ALTER TABLE orchestration_runs
  ADD COLUMN IF NOT EXISTS active_subject_key text,
  ADD COLUMN IF NOT EXISTS unresolved_operation_id uuid,
  ADD COLUMN IF NOT EXISTS final_effect_refs jsonb,
  ADD COLUMN IF NOT EXISTS final_evidence_sha256 text;

ALTER TABLE orchestration_runs
  DROP CONSTRAINT IF EXISTS orchestration_runs_active_subject_key_fkey,
  DROP CONSTRAINT IF EXISTS orchestration_runs_unresolved_operation_id_fkey;

ALTER TABLE orchestration_runs
  ADD CONSTRAINT orchestration_runs_active_subject_key_fkey
    FOREIGN KEY (active_subject_key) REFERENCES execution_state(subject_key),
  ADD CONSTRAINT orchestration_runs_unresolved_operation_id_fkey
    FOREIGN KEY (unresolved_operation_id) REFERENCES operation_state(operation_id);
