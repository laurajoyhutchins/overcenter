function invalid(message, details = {}) {
  const error = new Error(message);
  error.code = 'REQUEST_INVALID';
  error.details = details;
  return error;
}

function requireReader(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  return value;
}

function invocationRef(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 128) {
    throw invalid('invocation_ref must be a non-empty string of at most 128 characters', { field:'invocation_ref' });
  }
  return value.trim();
}

function boundedProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 32));
}

function snapshot(row) {
  if (!row) return null;
  return Object.freeze({
    schema:'invocation-observation-v1',
    invocation_ref:String(row.invocation_id),
    run_id:String(row.run_id),
    sequence:Number(row.sequence),
    command:String(row.command),
    target:Object.freeze({ kind:row.target_kind || null, ref:row.target_ref || null }),
    request_sha256:row.request_sha256 || null,
    request:boundedProjection(row.request_projection),
    outcome:String(row.outcome),
    started_at:row.started_at || null,
    completed_at:row.completed_at || null,
    error:row.error_code ? Object.freeze({
      code:String(row.error_code),
      class:row.error_class || null,
      retryable:row.retryable === true,
      rejection:row.rejection === true,
      may_have_mutated:row.may_have_mutated === true,
    }) : null,
    result_sha256:row.result_sha256 || null,
    result:boundedProjection(row.result_projection),
  });
}

export function createInvocationObservationService(options = {}) {
  const readInvocation = requireReader(options.readInvocation, 'readInvocation');
  const readRun = requireReader(options.readRun, 'readRun');

  async function peek(input = {}) {
    const ref = invocationRef(input.invocation_ref);
    const observed = snapshot(await readInvocation(ref));
    if (!observed) throw invalid('invocation_ref does not identify a durable invocation', { field:'invocation_ref', invocation_ref:ref });
    return Object.freeze({ ok:true, ...observed });
  }

  async function attach(input = {}) {
    const observed = await peek(input);
    const run = await readRun(observed.run_id);
    const runState = run ? Object.freeze({ run_id:String(run.run_id), status:String(run.status) }) : null;
    return Object.freeze({
      ...observed,
      schema:'invocation-attachment-v1',
      run:runState,
      resume_ref:runState?.status === 'active' ? runState.run_id : null,
    });
  }

  return Object.freeze({ peek, attach });
}

export function createPostgresInvocationObservationService(options = {}) {
  const db = options.db;
  if (!db || typeof db.query !== 'function') throw new TypeError('db is required');
  return createInvocationObservationService({
    async readInvocation(ref) {
      const result = await db.query(`SELECT invocation_id, run_id, sequence, command, target_kind, target_ref,
        request_sha256, request_projection, outcome, started_at, completed_at,
        error_code, error_class, retryable, rejection, may_have_mutated,
        result_sha256, result_projection
        FROM orchestration_command_invocations WHERE invocation_id=$1`, [ref]);
      return result.rows?.[0] || null;
    },
    async readRun(runId) {
      const result = await db.query('SELECT run_id, status FROM orchestration_runs WHERE run_id=$1', [runId]);
      return result.rows?.[0] || null;
    },
  });
}