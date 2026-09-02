ALTER TABLE orchestration_runs
  ADD COLUMN IF NOT EXISTS current_failure_command text,
  ADD COLUMN IF NOT EXISTS current_failure_error_code text,
  ADD COLUMN IF NOT EXISTS current_failure_error_class text,
  ADD COLUMN IF NOT EXISTS current_failure_retryable boolean,
  ADD COLUMN IF NOT EXISTS current_failure_rejection boolean,
  ADD COLUMN IF NOT EXISTS current_failure_may_have_mutated boolean,
  ADD COLUMN IF NOT EXISTS current_failure_streak integer NOT NULL DEFAULT 0;

ALTER TABLE orchestration_runs
  DROP CONSTRAINT IF EXISTS orchestration_runs_current_failure_check;

ALTER TABLE orchestration_runs
  ADD CONSTRAINT orchestration_runs_current_failure_check CHECK (
    current_failure_streak >= 0
    AND (
      (
        current_failure_error_code IS NULL
        AND current_failure_command IS NULL
        AND current_failure_error_class IS NULL
        AND current_failure_retryable IS NULL
        AND current_failure_rejection IS NULL
        AND current_failure_may_have_mutated IS NULL
        AND current_failure_streak = 0
      )
      OR (
        current_failure_error_code IS NOT NULL
        AND current_failure_command IS NOT NULL
        AND current_failure_streak >= 1
      )
    )
  );
