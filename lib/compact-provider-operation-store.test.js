import { createCompactProviderOperationPostgresStore } from 'lib/compact-provider-operation-store.js';

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

async function run(name, fn) {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: String(error?.message || error) };
  }
}

function clone(row) {
  return row ? structuredClone(row) : row;
}

function createOperationDb() {
  let row = null;
  return {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, ' ').trim();
      if (compact.startsWith('INSERT INTO operation_state')) {
        if (row) return { rows: [], rowCount: 0 };
        row = {
          operation_id: params[0],
          command: params[1],
          idempotency_scope: params[2],
          idempotency_key: params[3],
          request_sha256: params[4],
          state: 'prepared',
          subject_key: params[5],
          run_id: params[6],
          lease_epoch: params[7],
          authority_revision: params[8],
          may_have_mutated: false,
          recovery_payload: JSON.parse(params[9]),
          created_at: params[10],
          updated_at: params[10],
          ...(compact.includes('attempt_epoch') ? { attempt_epoch: 1 } : {}),
        };
        return { rows: [clone(row)], rowCount: 1 };
      }
      if (compact.startsWith('SELECT * FROM operation_state')) {
        return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
      }
      if (compact.includes("state='prepared'") && compact.includes('updated_at < $7')) {
        if (!row || row.state !== 'prepared') return { rows: [], rowCount: 0 };
        row.recovery_payload = JSON.parse(params[4]);
        row.updated_at = params[5];
        if (/attempt_epoch\s*=\s*attempt_epoch\s*\+\s*1/.test(compact)) row.attempt_epoch += 1;
        return { rows: [clone(row)], rowCount: 1 };
      }
      if (compact.includes("SET state='indeterminate'")) {
        if (!row || row.recovery_payload?.attempt_token !== params[3]) return { rows: [], rowCount: 0 };
        row.state = 'indeterminate';
        row.may_have_mutated = true;
        row.recovery_payload = JSON.parse(params[4]);
        row.updated_at = params[5];
        return { rows: [clone(row)], rowCount: 1 };
      }
      if (compact.includes("request_sha256=$4 AND state='indeterminate'")) {
        if (!row || row.state !== 'indeterminate' || row.recovery_payload?.attempt_token !== params[4]) return { rows: [], rowCount: 0 };
        row.recovery_payload = JSON.parse(params[6]);
        row.updated_at = params[5];
        if (/attempt_epoch\s*=\s*attempt_epoch\s*\+\s*1/.test(compact)) row.attempt_epoch += 1;
        return { rows: [clone(row)], rowCount: 1 };
      }
      throw new Error(`unexpected SQL in operation-attempt regression: ${compact}`);
    },
  };
}

function claimInput(attemptToken, createdAt) {
  return {
    command: 'github.apply_changeset',
    scope: 'repo:laurajoyhutchins/overcenter',
    idempotency_key: 'same-logical-operation',
    request_sha256: 'a'.repeat(64),
    attempt_token: attemptToken,
    created_at: createdAt,
    stale_before: '2026-09-05T23:59:59.000Z',
    recovery_payload: { phase: 'prepared' },
    authority_revision: 'b'.repeat(40),
  };
}

export async function runCompactProviderOperationStoreTests() {
  const results = [];
  results.push(await run('durable attempt epoch increments across stale takeover and recovery resume', async () => {
    const store = createCompactProviderOperationPostgresStore(createOperationDb());
    const first = await store.claim(claimInput('attempt-1', '2026-09-05T23:00:00.000Z'));
    assert(first.outcome === 'claimed' && first.recovered === false, 'initial operation was not claimed');
    assert(first.operation.attempt_epoch === 1, `initial attempt epoch was ${first.operation.attempt_epoch}`);

    const second = await store.claim(claimInput('attempt-2', '2026-09-06T00:00:00.000Z'));
    assert(second.outcome === 'claimed' && second.recovered === true, 'stale operation was not reclaimed');
    assert(second.operation.operation_id === first.operation.operation_id, 'idempotent logical operation identity changed');
    assert(second.operation.attempt_epoch === 2, `reclaimed attempt epoch was ${second.operation.attempt_epoch}`);

    const indeterminate = await store.markIndeterminate({
      command: 'github.apply_changeset',
      scope: 'repo:laurajoyhutchins/overcenter',
      idempotency_key: 'same-logical-operation',
      attempt_token: 'attempt-2',
      updated_at: '2026-09-06T00:01:00.000Z',
      recovery_payload: { phase: 'transport_ambiguous' },
    });
    assert(indeterminate?.attempt_epoch === 2, 'same attempt changed epoch while becoming indeterminate');

    const resumed = await store.resumeIndeterminate({
      command: 'github.apply_changeset',
      scope: 'repo:laurajoyhutchins/overcenter',
      idempotency_key: 'same-logical-operation',
      request_sha256: 'a'.repeat(64),
      prior_attempt_token: 'attempt-2',
      attempt_token: 'attempt-3',
      updated_at: '2026-09-06T00:02:00.000Z',
      recovery_payload: { phase: 'reconcile_then_retry' },
    });
    assert(resumed?.operation_id === first.operation.operation_id, 'recovery resume changed logical operation identity');
    assert(resumed?.attempt_epoch === 3, `resumed attempt epoch was ${resumed?.attempt_epoch}`);
    assert(resumed?.recovery_payload?.attempt_token === 'attempt-3', 'resumed attempt token was not fenced to the new attempt');
  }));
  return results;
}