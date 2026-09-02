function required(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new TypeError(`${field} must be a non-empty string`);
  return text;
}

function jsonObject(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function operation(row) {
  if (!row) return null;
  return Object.freeze({
    ...row,
    operation_id:String(row.operation_id || ''),
    command:String(row.command || ''),
    idempotency_scope:String(row.idempotency_scope || ''),
    idempotency_key:String(row.idempotency_key || ''),
    request_sha256:String(row.request_sha256 || ''),
    state:String(row.state || ''),
    may_have_mutated:Boolean(row.may_have_mutated),
    recovery_payload:jsonObject(row.recovery_payload),
    resolution:jsonObject(row.resolution),
  });
}

function payload(value, attemptToken, extra = {}) {
  return JSON.stringify({ ...(jsonObject(value) || {}), ...extra, attempt_token:attemptToken });
}

function terminal(state) {
  return state === 'succeeded' || state === 'no_effect' || state === 'rejected';
}

export function createCompactProviderOperationPostgresStore(dbBinding) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('dbBinding is required');

  async function one(sql, params = []) {
    const result = await dbBinding.query(sql, params);
    return operation(result?.rows?.[0] || null);
  }

  async function get(command, scope, idempotencyKey) {
    return one(
      `SELECT * FROM operation_state
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
        LIMIT 1`,
      [required(command, 'command'), required(scope, 'scope'), required(idempotencyKey, 'idempotency_key')],
    );
  }

  async function claim(input = {}) {
    const command = required(input.command, 'command');
    const scope = required(input.scope, 'scope');
    const key = required(input.idempotency_key, 'idempotency_key');
    const requestSha = required(input.request_sha256, 'request_sha256');
    const attemptToken = required(input.attempt_token, 'attempt_token');
    const createdAt = required(input.created_at, 'created_at');
    const staleBefore = required(input.stale_before, 'stale_before');
    const operationId = crypto.randomUUID();
    const recovery = payload(input.recovery_payload, attemptToken);

    const inserted = await one(
      `INSERT INTO operation_state (
         operation_id,command,idempotency_scope,idempotency_key,request_sha256,state,
         subject_key,run_id,lease_epoch,authority_revision,may_have_mutated,
         recovery_payload,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,'prepared',$6,$7,$8,$9,false,$10::jsonb,$11,$11)
       ON CONFLICT (command,idempotency_scope,idempotency_key) DO NOTHING
       RETURNING *`,
      [
        operationId, command, scope, key, requestSha,
        input.subject_key || null, input.run_id || null, input.lease_epoch ?? null, input.authority_revision || null,
        recovery, createdAt,
      ],
    );
    if (inserted) return Object.freeze({ outcome:'claimed', recovered:false, operation:inserted });

    let existing = await get(command, scope, key);
    if (!existing) throw new Error('compact provider operation claim disappeared after idempotency conflict');
    if (existing.request_sha256 !== requestSha) return Object.freeze({ outcome:'conflict', recovered:false, operation:existing });
    if (terminal(existing.state)) return Object.freeze({ outcome:'terminal', recovered:false, operation:existing });
    if (existing.state === 'indeterminate') return Object.freeze({ outcome:'indeterminate', recovered:false, operation:existing });

    const taken = await one(
      `UPDATE operation_state
          SET recovery_payload=$5::jsonb, updated_at=$6
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
          AND request_sha256=$4 AND state='prepared' AND updated_at < $7
        RETURNING *`,
      [command, scope, key, requestSha, recovery, createdAt, staleBefore],
    );
    if (taken) return Object.freeze({ outcome:'claimed', recovered:true, operation:taken });
    existing = await get(command, scope, key);
    if (existing?.request_sha256 !== requestSha) return Object.freeze({ outcome:'conflict', recovered:false, operation:existing });
    if (existing && terminal(existing.state)) return Object.freeze({ outcome:'terminal', recovered:false, operation:existing });
    if (existing?.state === 'indeterminate') return Object.freeze({ outcome:'indeterminate', recovered:false, operation:existing });
    return Object.freeze({ outcome:'in_progress', recovered:false, operation:existing });
  }

  async function heartbeat(input = {}) {
    const command = required(input.command, 'command');
    const scope = required(input.scope, 'scope');
    const key = required(input.idempotency_key, 'idempotency_key');
    const attemptToken = required(input.attempt_token, 'attempt_token');
    const updatedAt = required(input.updated_at, 'updated_at');
    const phase = required(input.phase, 'phase');
    const result = await dbBinding.query(
      `UPDATE operation_state
          SET recovery_payload=COALESCE(recovery_payload,'{}'::jsonb) || jsonb_build_object('phase',$5::text),
              updated_at=$6
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
          AND state IN ('prepared','indeterminate') AND recovery_payload->>'attempt_token'=$4`,
      [command, scope, key, attemptToken, phase, updatedAt],
    );
    return Number(result?.rowCount || 0) === 1;
  }

  async function updateRecovery(input = {}) {
    const command = required(input.command, 'command');
    const scope = required(input.scope, 'scope');
    const key = required(input.idempotency_key, 'idempotency_key');
    const attemptToken = required(input.attempt_token, 'attempt_token');
    const updatedAt = required(input.updated_at, 'updated_at');
    return one(
      `UPDATE operation_state
          SET recovery_payload=$5::jsonb, updated_at=$6
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
          AND state IN ('prepared','indeterminate')
          AND recovery_payload->>'attempt_token'=$4
        RETURNING *`,
      [command, scope, key, attemptToken, payload(input.recovery_payload, attemptToken), updatedAt],
    );
  }

  async function resumeIndeterminate(input = {}) {
    const command = required(input.command, 'command');
    const scope = required(input.scope, 'scope');
    const key = required(input.idempotency_key, 'idempotency_key');
    const requestSha = required(input.request_sha256, 'request_sha256');
    const priorAttemptToken = required(input.prior_attempt_token, 'prior_attempt_token');
    const attemptToken = required(input.attempt_token, 'attempt_token');
    const updatedAt = required(input.updated_at, 'updated_at');
    return one(
      `UPDATE operation_state
          SET recovery_payload=$7::jsonb, updated_at=$6
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
          AND request_sha256=$4 AND state='indeterminate'
          AND recovery_payload->>'attempt_token'=$5
        RETURNING *`,
      [command, scope, key, requestSha, priorAttemptToken, updatedAt, payload(input.recovery_payload, attemptToken)],
    );
  }

  async function markIndeterminate(input = {}) {
    const command = required(input.command, 'command');
    const scope = required(input.scope, 'scope');
    const key = required(input.idempotency_key, 'idempotency_key');
    const attemptToken = required(input.attempt_token, 'attempt_token');
    const updatedAt = required(input.updated_at, 'updated_at');
    return one(
      `UPDATE operation_state
          SET state='indeterminate', may_have_mutated=true,
              recovery_payload=$5::jsonb, resolved_at=NULL, updated_at=$6
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
          AND state IN ('prepared','indeterminate')
          AND recovery_payload->>'attempt_token'=$4
        RETURNING *`,
      [command, scope, key, attemptToken, payload(input.recovery_payload, attemptToken), updatedAt],
    );
  }

  async function succeed(input = {}) {
    const command = required(input.command, 'command');
    const scope = required(input.scope, 'scope');
    const key = required(input.idempotency_key, 'idempotency_key');
    const attemptToken = required(input.attempt_token, 'attempt_token');
    const updatedAt = required(input.updated_at, 'updated_at');
    const effectKind = input.effect_kind ? required(input.effect_kind, 'effect_kind') : null;
    const effectRef = input.effect_ref ? required(input.effect_ref, 'effect_ref') : null;
    const mayHaveMutated = input.may_have_mutated !== false;
    return one(
      `UPDATE operation_state
          SET state='succeeded', may_have_mutated=$5,
              effect_kind=$6, effect_ref=$7, effect_sha256=$8, result_sha256=$9,
              recovery_payload=NULL, resolution=$10::jsonb, resolved_at=$11, updated_at=$11
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
          AND state IN ('prepared','indeterminate')
          AND recovery_payload->>'attempt_token'=$4
        RETURNING *`,
      [
        command, scope, key, attemptToken, mayHaveMutated,
        effectKind, effectRef, input.effect_sha256 || null, input.result_sha256 || null,
        JSON.stringify(jsonObject(input.resolution) || {}), updatedAt,
      ],
    );
  }

  async function resolveNoEffect(input = {}) {
    const command = required(input.command, 'command');
    const scope = required(input.scope, 'scope');
    const key = required(input.idempotency_key, 'idempotency_key');
    const attemptToken = required(input.attempt_token, 'attempt_token');
    const updatedAt = required(input.updated_at, 'updated_at');
    return one(
      `UPDATE operation_state
          SET state='no_effect', may_have_mutated=false, effect_kind=NULL, effect_ref=NULL,
              effect_sha256=NULL, result_sha256=$5, recovery_payload=NULL,
              resolution=$6::jsonb, resolved_at=$7, updated_at=$7
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
          AND state IN ('prepared','indeterminate')
          AND recovery_payload->>'attempt_token'=$4
        RETURNING *`,
      [command, scope, key, attemptToken, input.result_sha256 || null, JSON.stringify(jsonObject(input.resolution) || {}), updatedAt],
    );
  }

  async function abandon(input = {}) {
    const result = await dbBinding.query(
      `DELETE FROM operation_state
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
          AND state='prepared' AND may_have_mutated=false
          AND recovery_payload->>'attempt_token'=$4`,
      [required(input.command, 'command'), required(input.scope, 'scope'), required(input.idempotency_key, 'idempotency_key'), required(input.attempt_token, 'attempt_token')],
    );
    return Number(result?.rowCount || 0) === 1;
  }

  return Object.freeze({ get, claim, heartbeat, updateRecovery, resumeIndeterminate, markIndeterminate, succeed, resolveNoEffect, abandon });
}
