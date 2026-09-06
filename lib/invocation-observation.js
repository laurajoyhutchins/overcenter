const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fail(code, message, details = null, httpStatus = 422) {
  throw Object.assign(new Error(message), { code, details, httpStatus, may_have_mutated: false });
}

function invocationId(input) {
  const value = typeof input?.invocation_id === 'string' ? input.invocation_id.trim().toLowerCase() : '';
  if (!UUID.test(value)) fail('REQUEST_INVALID', 'invocation_id must be an exact UUID', { field: 'invocation_id' }, 400);
  return value;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function observation(row) {
  return Object.freeze({
    schema: 'invocation-observation-v1',
    invocation_id: String(row.invocation_id),
    run_id: String(row.run_id),
    sequence: Number(row.sequence),
    command: String(row.command),
    target_kind: row.target_kind == null ? null : String(row.target_kind),
    target_ref: row.target_ref == null ? null : String(row.target_ref),
    request_sha256: row.request_sha256 == null ? null : String(row.request_sha256),
    request: Object.freeze({ ...object(row.request_projection) }),
    started_at: row.started_at == null ? null : String(row.started_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    outcome: String(row.outcome),
    error_code: row.error_code == null ? null : String(row.error_code),
    error_class: row.error_class == null ? null : String(row.error_class),
    retryable: row.retryable == null ? null : Boolean(row.retryable),
    rejection: row.rejection == null ? null : Boolean(row.rejection),
    may_have_mutated: row.may_have_mutated == null ? null : Boolean(row.may_have_mutated),
    result_sha256: row.result_sha256 == null ? null : String(row.result_sha256),
    result: Object.freeze({ ...object(row.result_projection) }),
    journal_schema: String(row.schema_version || 'orchestration-journal-v1'),
  });
}

export function createInvocationObservationService({ store } = {}) {
  if (!store || typeof store.read !== 'function') throw new TypeError('invocation observation store is required');

  async function peek(input) {
    const id = invocationId(input);
    const row = await store.read(id);
    if (!row) fail('INVOCATION_NOT_FOUND', 'invocation does not exist', { invocation_id: id }, 404);
    return observation(row);
  }

  async function attach(input) {
    const current = await peek(input);
    return Object.freeze({
      schema: 'invocation-attachment-v1',
      invocation_id: current.invocation_id,
      attachment: Object.freeze({
        schema: 'invocation-ref-v1',
        invocation_id: current.invocation_id,
        run_id: current.run_id,
        sequence: current.sequence,
      }),
      observation: current,
    });
  }

  return Object.freeze({ peek, attach });
}

export function createPostgresInvocationObservationStore(db) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db is required');
  return Object.freeze({
    async read(id) {
      const result = await db.query('SELECT invocation_id, run_id, sequence, command, target_kind, target_ref, request_sha256, request_projection, started_at, completed_at, outcome, error_code, error_class, retryable, rejection, may_have_mutated, result_sha256, result_projection, schema_version FROM orchestration_command_invocations WHERE invocation_id=$1 LIMIT 1', [id]);
      return result.rows?.[0] || null;
    },
  });
}

export function invocationObservationFor(db) {
  return createInvocationObservationService({ store: createPostgresInvocationObservationStore(db) });
}