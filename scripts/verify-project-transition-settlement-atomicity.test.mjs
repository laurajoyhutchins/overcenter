import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectTransitionLeasePostgresStore } from '../lib/project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from '../lib/project-transition-leases.js';
import { PRODUCTIVE_STAGES } from '../lib/work-lifecycle.js';

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}

function graphFixture() {
  return {
    schema:'project-graph-authority-v1',
    project_ref:'github:laurajoyhutchins/overcenter',
    authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1'.repeat(40), derivation:'overcenter-project-graph-v1' }, observations:[] },
    nodes:[{ id:'transition-a', priority:1, requires:[], lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') }, executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' }, phase_bindings:{} }],
    horizons:[],
  };
}

test('project transition settlement delegates the lease and slot state change to one atomic store primitive', async () => {
  const leases = new Map();
  const slots = new Map();
  const runs = new Map([['run-1', { run_id:'run-1', status:'active', deadline_at:'2026-09-01T03:00:00Z' }]]);
  let atomicCalls = 0;
  let splitSettlementUpdateCalled = false;
  let splitSlotDeleteCalled = false;
  const store = {
    async getRun(id) { return runs.get(id) || null; },
    async getLease(id) { return leases.get(id) || null; },
    async getLeaseByAcquireIdempotency(key) { return [...leases.values()].find((row) => row.acquire_idempotency_key === key) || null; },
    async getSlot(key) { return slots.get(key) || null; },
    async insertLease(row) { leases.set(row.lease_id, { ...row }); return leases.get(row.lease_id); },
    async insertSlot(row) { slots.set(row.slot_key, { ...row }); return slots.get(row.slot_key); },
    async updateLease(id, patch) {
      if (patch.status === 'settled') {
        splitSettlementUpdateCalled = true;
        throw new Error('settlement must not update the lease outside the atomic store primitive');
      }
      const next = { ...leases.get(id), ...patch };
      leases.set(id, next);
      return next;
    },
    async deleteSlot() {
      splitSlotDeleteCalled = true;
      throw new Error('settlement must not delete the slot outside the atomic store primitive');
    },
    async settleLeaseAtomically(input) {
      atomicCalls += 1;
      const current = leases.get(input.lease_id);
      const next = {
        ...current,
        status:'settled',
        disposition:input.disposition,
        settle_idempotency_key:input.settle_idempotency_key,
        settled_at:input.settled_at,
        graph_revision_change:input.graph_revision_change || null,
      };
      leases.set(input.lease_id, next);
      slots.delete(input.slot_key);
      return next;
    },
  };
  const graph = graphFixture();
  const service = createProjectTransitionLeaseService({
    store,
    readProjectGraph:async () => graph,
    now:() => '2026-09-01T01:40:00Z',
    uuid:() => '00000000-0000-4000-8000-000000000001',
  });
  const lease = await service.acquire({
    run_id:'run-1',
    project_ref:graph.project_ref,
    transition_id:'transition-a',
    lease_seconds:600,
    idempotency_key:'acquire-atomic-settlement',
  });
  const settled = await service.settle({
    lease_ref:lease.lease_ref,
    run_id:'run-1',
    disposition:'completed',
    idempotency_key:'settle-atomic-settlement',
  });
  assert.equal(settled.status, 'settled');
  assert.equal(atomicCalls, 1);
  assert.equal(splitSettlementUpdateCalled, false);
  assert.equal(splitSlotDeleteCalled, false);
});

test('postgres project transition settlement writes the lease receipt and releases the slot in one transaction', async () => {
  const leaseId = '00000000-0000-4000-8000-000000000002';
  const slotKey = 'project_transition:github:laurajoyhutchins/overcenter:transition-a';
  const transactions = [];
  const rawSettledRow = {
    lease_id:leaseId,
    work_ref:slotKey,
    gate:'project_transition',
    run_id:'run-1',
    status:'settled',
    created_at:'2026-09-01T01:30:00Z',
    expires_at:'2026-09-01T02:00:00Z',
    hard_expires_at:'2026-09-01T03:00:00Z',
    claim_idempotency_key:'project-transition:acquire',
    claim_request_hash:'a'.repeat(64),
    claim_receipt:{
      subject:'project_transition',
      project_transition:{
        project_ref:'github:laurajoyhutchins/overcenter',
        transition_id:'transition-a',
        repository:'laurajoyhutchins/overcenter',
        authority_revision:'1'.repeat(40),
        authority_derivation:'overcenter-project-graph-v1',
        graph_fingerprint:'b'.repeat(64),
        transition_definition_fingerprint:'c'.repeat(64),
        transition_revision_fingerprint:'d'.repeat(64),
        transition_dependency_fingerprint:'e'.repeat(64),
        slot_key:slotKey,
      },
    },
    settle_idempotency_key:'project-transition-settle:settle',
    settle_plan:{ subject:'project_transition', disposition:'completed' },
    settle_receipt:{ subject:'project_transition', disposition:'completed', graph_revision_change:null },
    settled_at:'2026-09-01T01:45:00Z',
  };
  const db = {
    async query() { throw new Error('atomic settlement must not use standalone db.query calls'); },
    async transaction(statements) {
      transactions.push(statements);
      return { results:[{ rows:[rawSettledRow] }, { rows:[{ lease_id:leaseId }] }, { rows:[{ atomicity_guard:1 }] }] };
    },
  };
  const store = createProjectTransitionLeasePostgresStore(db, { capabilityFactory:() => 'unused' });
  const settled = await store.settleLeaseAtomically({
    lease_id:leaseId,
    slot_key:slotKey,
    run_id:'run-1',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'transition-a',
    repository:'laurajoyhutchins/overcenter',
    authority_revision:'1'.repeat(40),
    authority_derivation:'overcenter-project-graph-v1',
    graph_fingerprint:'b'.repeat(64),
    transition_definition_fingerprint:'c'.repeat(64),
    transition_revision_fingerprint:'d'.repeat(64),
    transition_dependency_fingerprint:'e'.repeat(64),
    disposition:'completed',
    settle_idempotency_key:'settle',
    settled_at:'2026-09-01T01:45:00Z',
    graph_revision_change:null,
  });
  assert.equal(settled.status, 'settled');
  assert.equal(transactions.length, 1);
  const sql = transactions[0].map((statement) => statement.sql).join('\n');
  assert.match(sql, /UPDATE work_leases/);
  assert.match(sql, /DELETE FROM work_lease_slots/);
  assert.match(sql, /atomicity_guard/);
});