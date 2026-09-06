import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompactProviderOperationPostgresStore } from '../lib/compact-provider-operation-store.js';

function clone(row) { return row ? structuredClone(row) : row; }

function createOperationDb() {
  let row = null;
  return {
    async query(sql, params = []) {
      const compact = String(sql).replace(/\s+/g, ' ').trim();
      if (compact.startsWith('INSERT INTO operation_state')) {
        if (row) return { rows: [], rowCount: 0 };
        row = {
          operation_id: params[0], command: params[1], idempotency_scope: params[2], idempotency_key: params[3],
          request_sha256: params[4], state: 'prepared', subject_key: params[5], run_id: params[6], lease_epoch: params[7],
          authority_revision: params[8], may_have_mutated: false, recovery_payload: JSON.parse(params[9]),
          created_at: params[10], updated_at: params[10], ...(compact.includes('attempt_epoch') ? { attempt_epoch: 1 } : {}),
        };
        return { rows: [clone(row)], rowCount: 1 };
      }
      if (compact.startsWith('SELECT * FROM operation_state')) return { rows: row ? [clone(row)] : [], rowCount: row ? 1 : 0 };
      if (compact.includes("state='prepared'") && compact.includes('updated_at < $7')) {
        if (!row || row.state !== 'prepared') return { rows: [], rowCount: 0 };
        row.recovery_payload = JSON.parse(params[4]); row.updated_at = params[5];
        if (/attempt_epoch\s*=\s*attempt_epoch\s*\+\s*1/.test(compact)) row.attempt_epoch += 1;
        return { rows: [clone(row)], rowCount: 1 };
      }
      if (compact.includes("SET state='indeterminate'")) {
        if (!row || row.recovery_payload?.attempt_token !== params[3]) return { rows: [], rowCount: 0 };
        row.state = 'indeterminate'; row.may_have_mutated = true; row.recovery_payload = JSON.parse(params[4]); row.updated_at = params[5];
        return { rows: [clone(row)], rowCount: 1 };
      }
      if (compact.includes("request_sha256=$4 AND state='indeterminate'")) {
        if (!row || row.state !== 'indeterminate' || row.recovery_payload?.attempt_token !== params[4]) return { rows: [], rowCount: 0 };
        row.recovery_payload = JSON.parse(params[6]); row.updated_at = params[5];
        if (/attempt_epoch\s*=\s*attempt_epoch\s*\+\s*1/.test(compact)) row.attempt_epoch += 1;
        return { rows: [clone(row)], rowCount: 1 };
      }
      throw new Error(`unexpected SQL in attempt-epoch regression: ${compact}`);
    },
  };
}

function claimInput(attemptToken, createdAt) {
  return {
    command: 'github.apply_changeset', scope: 'repo:laurajoyhutchins/overcenter', idempotency_key: 'same-logical-operation',
    request_sha256: 'a'.repeat(64), attempt_token: attemptToken, created_at: createdAt, stale_before: '2026-09-05T23:59:59.000Z',
    recovery_payload: { phase: 'prepared' }, authority_revision: 'b'.repeat(40),
  };
}

test('attempt epoch is durable and increments only when a new provider attempt begins', async () => {
  const store = createCompactProviderOperationPostgresStore(createOperationDb());
  const first = await store.claim(claimInput('attempt-1', '2026-09-05T23:00:00.000Z'));
  assert.equal(first.outcome, 'claimed'); assert.equal(first.recovered, false); assert.equal(first.operation.attempt_epoch, 1);

  const second = await store.claim(claimInput('attempt-2', '2026-09-06T00:00:00.000Z'));
  assert.equal(second.outcome, 'claimed'); assert.equal(second.recovered, true);
  assert.equal(second.operation.operation_id, first.operation.operation_id); assert.equal(second.operation.attempt_epoch, 2);

  const indeterminate = await store.markIndeterminate({
    command: 'github.apply_changeset', scope: 'repo:laurajoyhutchins/overcenter', idempotency_key: 'same-logical-operation',
    attempt_token: 'attempt-2', updated_at: '2026-09-06T00:01:00.000Z', recovery_payload: { phase: 'transport_ambiguous' },
  });
  assert.equal(indeterminate.attempt_epoch, 2);

  const resumed = await store.resumeIndeterminate({
    command: 'github.apply_changeset', scope: 'repo:laurajoyhutchins/overcenter', idempotency_key: 'same-logical-operation',
    request_sha256: 'a'.repeat(64), prior_attempt_token: 'attempt-2', attempt_token: 'attempt-3',
    updated_at: '2026-09-06T00:02:00.000Z', recovery_payload: { phase: 'reconcile_then_retry' },
  });
  assert.equal(resumed.operation_id, first.operation.operation_id); assert.equal(resumed.attempt_epoch, 3);
  assert.equal(resumed.recovery_payload.attempt_token, 'attempt-3');
});