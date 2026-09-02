import { db } from 'hatchable';

function failureFields(command, responseBody) {
  const body = responseBody && typeof responseBody === 'object' && !Array.isArray(responseBody) ? responseBody : {};
  return {
    command:String(command || 'unknown'),
    error_code:String(body.error || 'INTERNAL_ERROR'),
    error_class:String(body.error_class || 'internal'),
    retryable:Boolean(body.retryable),
    rejection:Boolean(body.rejection),
    may_have_mutated:body.may_have_mutated === true || body.details?.may_have_mutated === true,
  };
}

export function createPostgresOrchestrationCurrentFailureStore(dbBinding = db) {
  return {
    async record(runId, command, responseBody) {
      if (responseBody?.ok === true) {
        const result = await dbBinding.query(`UPDATE orchestration_runs SET
          current_failure_command = NULL,
          current_failure_error_code = NULL,
          current_failure_error_class = NULL,
          current_failure_retryable = NULL,
          current_failure_rejection = NULL,
          current_failure_may_have_mutated = NULL,
          current_failure_streak = 0,
          updated_at = GREATEST(updated_at, now())
          WHERE run_id = $1
            AND (
              current_failure_command IS NULL
              OR current_failure_command = $2
              OR (current_failure_command = 'work.heartbeat' AND $2 = 'work.settle')
            )
          RETURNING run_id, current_failure_streak`, [runId, command]);
        return result.rows?.[0] || null;
      }

      const failure = failureFields(command, responseBody);
      const result = await dbBinding.query(`UPDATE orchestration_runs SET
        current_failure_streak = CASE
          WHEN current_failure_command = $2 AND current_failure_error_code = $3
            THEN current_failure_streak + 1
          ELSE 1
        END,
        current_failure_command = $2,
        current_failure_error_code = $3,
        current_failure_error_class = $4,
        current_failure_retryable = $5,
        current_failure_rejection = $6,
        current_failure_may_have_mutated = $7,
        updated_at = GREATEST(updated_at, now())
        WHERE run_id = $1
        RETURNING run_id, current_failure_command, current_failure_error_code,
          current_failure_error_class, current_failure_retryable, current_failure_rejection,
          current_failure_may_have_mutated, current_failure_streak`, [
        runId,
        failure.command,
        failure.error_code,
        failure.error_class,
        failure.retryable,
        failure.rejection,
        failure.may_have_mutated,
      ]);
      return result.rows?.[0] || null;
    },
  };
}

export const orchestrationCurrentFailureInternals = Object.freeze({ failureFields });
