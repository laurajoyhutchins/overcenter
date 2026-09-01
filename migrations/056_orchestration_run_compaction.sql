ALTER TABLE orchestration_runs
  ADD COLUMN IF NOT EXISTS active_subject_key text REFERENCES execution_state(subject_key),
  ADD COLUMN IF NOT EXISTS unresolved_operation_id uuid REFERENCES operation_state(operation_id),
  ADD COLUMN IF NOT EXISTS final_effect_refs jsonb,
  ADD COLUMN IF NOT EXISTS final_evidence_sha256 text;

ALTER TABLE orchestration_runs
  ADD CONSTRAINT orchestration_runs_final_effect_refs_array
    CHECK (final_effect_refs IS NULL OR jsonb_typeof(final_effect_refs) = 'array'),
  ADD CONSTRAINT orchestration_runs_final_evidence_sha256_shape
    CHECK (final_evidence_sha256 IS NULL OR final_evidence_sha256 ~ '^[0-9a-f]{64}$');

CREATE INDEX orchestration_runs_active_subject_idx
  ON orchestration_runs (active_subject_key) WHERE active_subject_key IS NOT NULL;
CREATE INDEX orchestration_runs_unresolved_operation_idx
  ON orchestration_runs (unresolved_operation_id) WHERE unresolved_operation_id IS NOT NULL;
