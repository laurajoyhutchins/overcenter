import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectTransitionLeasePostgresStore, reconcileExpiredLeaseItem } from '../lib/project-transition-lease-store.js';

test('expired project-transition ownership is recovered without Linear reconciliation', async () => {
  let linearCalls = 0;
  let graphCalls = 0;
  const result = await reconcileExpiredLeaseItem(
    { work_ref:'project_transition:project:revision:node', gate:'lane:repo-implementation', lease_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subject:'project_transition' },
    {
      workLeases:{ async reconcileExpired(){ linearCalls += 1; throw new Error('Linear recovery must not run'); } },
      projectTransitions:{ async reconcileExpired(slotKey, leaseId, observedAt){ graphCalls += 1; return { slot_key:slotKey, lease_ref:leaseId, observed_at:observedAt, released_without_linear_mutation:true }; } },
      observedAt:'2026-08-27T15:00:00Z',
    },
  );
  assert.equal(linearCalls, 0);
  assert.equal(graphCalls, 1);
  assert.equal(result.released_without_linear_mutation, true);
});

test('postgres graph expiry is subject-scoped and deletes only the exact slot', async () => {
  const calls = [];
  const db = {
    async query(sql, params){ calls.push({ kind:'query', sql, params }); return { rows:[], rowCount:0 }; },
    async transaction(statements){ calls.push({ kind:'transaction', statements }); return { results:[{rows:[{lease_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}]},{rows:[{lease_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}]}] }; },
  };
  const store = createProjectTransitionLeasePostgresStore(db);
  const result = await store.reconcileExpired('project_transition:project:revision:node','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-08-27T15:00:00Z');
  const tx = calls.find(call => call.kind === 'transaction');
  assert.ok(tx, 'expiry recovery was not transactional');
  const sql = tx.statements.map(statement => statement.sql).join('\n');
  assert.match(sql, /claim_receipt->>'subject' = 'project_transition'/);
  assert.match(sql, /DELETE FROM work_lease_slots/);
  assert.ok(tx.statements.some(statement => statement.params?.includes('lane:repo-implementation')), 'mutation gate was not exact');
  assert.equal(result.released_without_linear_mutation, true);
});