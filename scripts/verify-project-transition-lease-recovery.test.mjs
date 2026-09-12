import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectTransitionLeasePostgresStore, reconcileExpiredLeaseItem } from '../lib/project-transition-lease-store.js';
import { createSubjectAwareLeaseRecovery } from '../lib/orchestration-maintenance-subjects.js';
import { createPostgresOrchestrationMaintenanceStore } from '../lib/orchestration-runs.js';

test('expired project-transition ownership is recovered without Linear reconciliation', async () => {
  let linearCalls = 0;
  let graphCalls = 0;
  const result = await reconcileExpiredLeaseItem(
    { work_ref:'project_transition:project:revision:node', gate:'project_transition', lease_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', subject:'project_transition' },
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

test('postgres graph expiry classifies canonical certainty before releasing the projection', async () => {
  const calls = [];
  const leaseId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const db = {
    async query(sql, params) {
      calls.push({ kind:'query', sql, params });
      if (String(sql).includes('SELECT * FROM execution_state')) {
        return { rows:[{ subject_key:'project_transition:project:revision:node', lease_ref:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', transition_revision_fingerprint:'e'.repeat(64), transition_dependency_fingerprint:'f'.repeat(64) }] };
      }
      return { rows:[] };
    },
    async transaction(statements) {
      calls.push({ kind:'transaction', statements });
      return {
        results:[
          { rows:[{ subject_key:'project_transition:project:revision:node', lifecycle:'effect_absent', mutation_certainty:'definitely_not_mutated', lease_ref:null }] },
          { rows:[{ operation_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state:'no_effect', mutation_certainty:'definitely_not_mutated' }] },
          { rows:[{ lease_id }] },
          { rows:[{ lease_id }] },
          { rows:[{ atomicity_guard:1 }] },
        ],
      };
    },
  };
  const store = createProjectTransitionLeasePostgresStore(db);
  const result = await store.reconcileExpired('project_transition:project:revision:node', leaseId, '2026-08-27T15:00:00Z');
  const tx = calls.find(call => call.kind === 'transaction');
  assert.ok(tx, 'expiry recovery was not transactional');
  const sql = tx.statements.map(statement => statement.sql).join('\\n');
  assert.match(sql, /UPDATE execution_state/);
  assert.match(sql, /effect_absent/);
  assert.match(sql, /UPDATE operation_state/);
  assert.match(sql, /no_effect/);
  assert.match(sql, /DELETE FROM work_lease_slots/);
  assert.ok(tx.statements.some(statement => /atomicity_guard/.test(statement.sql)), 'expiry recovery lacks an atomicity guard');
  assert.ok(tx.statements.some(statement => statement.params?.includes('project_transition')), 'project-transition storage scope was not exact');
  assert.equal(result.released_without_linear_mutation, true);
  assert.equal(result.mutation_certainty, 'definitely_not_mutated');
});

test('postgres graph expiry refuses to requeue when canonical mutation remains uncertain', async () => {
  const calls = [];
  const leaseId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const subjectKey = 'project_transition:project:revision:uncertain';
  const db = {
    async query(sql, params) {
      calls.push({ kind:'query', sql, params });
      if (String(sql).includes('SELECT * FROM execution_state')) {
        return {
          rows:[{
            subject_key:subjectKey,
            lease_ref:leaseId,
            transition_revision_fingerprint:'e'.repeat(64),
            transition_dependency_fingerprint:'f'.repeat(64),
          }],
        };
      }
      return { rows:[] };
    },
    async transaction(statements) {
      calls.push({ kind:'transaction', statements });
      return {
        results:[
          { rows:[{ subject_key:subjectKey, lifecycle:'effect_uncertain', mutation_certainty:'may_have_mutated', lease_ref:leaseId }] },
          { rows:[{ operation_id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd', state:'indeterminate', mutation_certainty:'may_have_mutated' }] },
          { rows:[{ lease_id:leaseId }] },
          { rows:[{ lease_id:leaseId }] },
          { rows:[{ atomicity_guard:1 }] },
        ],
      };
    },
  };
  const store = createProjectTransitionLeasePostgresStore(db);
  const result = await store.reconcileExpired(subjectKey, leaseId, '2026-08-27T15:00:00Z');
  const tx = calls.find(call => call.kind === 'transaction');
  assert.ok(tx, 'uncertain expiry recovery was not transactional');
  const sql = tx.statements.map(statement => statement.sql).join('\\n');
  assert.match(sql, /effect_uncertain/);
  assert.match(sql, /indeterminate/);
  assert.equal(result.released_without_linear_mutation, false);
  assert.equal(result.recovery_required, true);
  assert.equal(result.mutation_certainty, 'may_have_mutated');
});


test('subject-aware expiry dispatch reads canonical project-transition execution before projection slots', async () => {
  const queries = [];
  const subjectKey = 'project_transition:project:revision:canonical-expiry';
  const leaseId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  let graphCalls = 0;
  const db = {
    async query(sql, params) {
      queries.push({ sql:String(sql), params });
      if (String(sql).includes('FROM execution_state') && String(sql).includes('project_transition')) {
        return { rows:[{ work_ref:subjectKey, gate:'project_transition', lease_id:leaseId, expires_at:'2026-08-27T14:59:00Z', subject:'project_transition' }] };
      }
      return { rows:[] };
    },
  };
  const recovery = createSubjectAwareLeaseRecovery({
    dbBinding:db,
    workLeases:{ claim(){}, settle(){} },
    projectTransitions:{
      async reconcileExpired(workRef, observedLeaseId, observedAt) {
        graphCalls += 1;
        return { work_ref:workRef, lease_ref:observedLeaseId, observed_at:observedAt, recovery_required:true };
      },
    },
    now:() => '2026-08-27T15:00:00Z',
  });
  const result = await recovery.reconcileExpired(subjectKey, 'project_transition');
  assert.equal(graphCalls, 1);
  assert.equal(result.recovery_required, true);
  assert.match(queries[0].sql, /FROM execution_state/);
  assert.doesNotMatch(queries[0].sql, /FROM work_lease_slots/);
});


test('maintenance enumerates expired canonical project-transition executions before projection slots', async () => {
  const calls = [];
  const store = createPostgresOrchestrationMaintenanceStore({
    async query(sql, params) {
      calls.push({ sql:String(sql), params });
      return { rows:[] };
    },
  });
  await store.expiredSlots(5);
  assert.match(calls[0].sql, /FROM execution_state/);
  assert.match(calls[0].sql, /UNION ALL/);
  assert.ok(calls[0].sql.indexOf('FROM execution_state') < calls[0].sql.indexOf('FROM work_lease_slots'));
});
