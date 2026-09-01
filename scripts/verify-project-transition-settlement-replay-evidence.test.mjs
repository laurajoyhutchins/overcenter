import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreProjectTransitionLease } from '../lib/project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from '../lib/project-transition-leases.js';
import { PRODUCTIVE_STAGES } from '../lib/work-lifecycle.js';

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}

const revisionChange = Object.freeze({
  schema:'project-graph-revision-change-v1',
  previous_authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1'.repeat(40), derivation:'overcenter-project-graph-v1' },
  current_authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'2'.repeat(40), derivation:'overcenter-project-graph-v1' },
  outcome:'unchanged',
});

test('idempotent project-transition settlement replay preserves graph revision evidence', async () => {
  const leases = new Map();
  const slots = new Map();
  const run = { run_id:'run-replay', status:'active', deadline_at:'2026-08-31T04:00:00Z' };
  const store = {
    async getRun(id) { return id === run.run_id ? run : null; },
    async getLease(id) { return leases.get(id) || null; },
    async getLeaseByAcquireIdempotency(key) { return [...leases.values()].find((row) => row.acquire_idempotency_key === key) || null; },
    async getSlot(key) { return slots.get(key) || null; },
    async insertLease(row) { leases.set(row.lease_id, { ...row }); return leases.get(row.lease_id); },
    async insertSlot(row) { slots.set(row.slot_key, { ...row }); return slots.get(row.slot_key); },
    async updateLease(id, patch) { const row = { ...leases.get(id), ...patch }; leases.set(id, row); return row; },
    async settleLeaseAtomically(input) {
      const row = {
        ...leases.get(input.lease_id),
        status:'settled',
        disposition:input.disposition,
        settle_idempotency_key:input.settle_idempotency_key,
        settled_at:input.settled_at,
        graph_revision_change:input.graph_revision_change || null,
      };
      leases.set(input.lease_id, row);
      if (slots.get(input.slot_key)?.lease_id === input.lease_id) slots.delete(input.slot_key);
      return row;
    },
    async deleteSlot(key, id) { if (slots.get(key)?.lease_id === id) slots.delete(key); },
  };
  const transition = { id:'transition-a', priority:1, requires:[], lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') }, executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' }, phase_bindings:{} };
  const authority = (revision) => ({ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision, derivation:'overcenter-project-graph-v1' }, observations:[] });
  let graph = { schema:'project-graph-authority-v1', project_ref:'github:laurajoyhutchins/overcenter', authority:authority('1'.repeat(40)), nodes:[transition], horizons:[] };
  const service = createProjectTransitionLeaseService({ store, readProjectGraph:async () => graph, now:() => '2026-08-31T02:00:00Z', uuid:() => '00000000-0000-4000-8000-000000000111' });
  const acquired = await service.acquire({ run_id:run.run_id, project_ref:graph.project_ref, transition_id:transition.id, lease_seconds:600, idempotency_key:'acquire-replay-evidence' });
  store.getActiveLeasesForTransition = async () => [await store.getLease(acquired.lease_ref)];
  graph = { ...graph, authority:authority('2'.repeat(40)) };
  const request = { lease_ref:acquired.lease_ref, run_id:run.run_id, disposition:'requeue', idempotency_key:'settle-replay-evidence' };
  const settled = await service.settle(request);
  const replayed = await service.settle(request);
  assert.equal(settled.graph_revision_change?.current_authority?.revision, '2'.repeat(40));
  assert.equal(replayed.idempotent_replay, true);
  assert.deepEqual(replayed.graph_revision_change, settled.graph_revision_change);
});

test('durable project-transition settlement restoration retains graph revision evidence', () => {
  const restored = restoreProjectTransitionLease({
    lease_id:'00000000-0000-4000-8000-000000000222',
    work_ref:`project_transition:github:laurajoyhutchins/overcenter:${'1'.repeat(40)}:transition-a`,
    gate:'project_transition',
    run_id:'run-replay',
    status:'settled',
    created_at:'2026-08-31T02:00:00Z',
    expires_at:'2026-08-31T02:10:00Z',
    hard_expires_at:'2026-08-31T04:00:00Z',
    claim_idempotency_key:'project-transition:acquire-replay-evidence',
    claim_request_hash:'a'.repeat(64),
    claim_receipt:{ subject:'project_transition', project_transition:{ project_ref:'github:laurajoyhutchins/overcenter', transition_id:'transition-a', repository:'laurajoyhutchins/overcenter', authority_revision:'1'.repeat(40), authority_derivation:'overcenter-project-graph-v1', graph_fingerprint:'b'.repeat(64), transition_definition_fingerprint:'c'.repeat(64), transition_revision_fingerprint:'d'.repeat(64), transition_dependency_fingerprint:'e'.repeat(64), slot_key:`project_transition:github:laurajoyhutchins/overcenter:${'1'.repeat(40)}:transition-a` } },
    settle_idempotency_key:'project-transition-settle:settle-replay-evidence',
    settle_plan:{ disposition:'requeue' },
    settle_receipt:{ schema:'project-transition-lease-settlement-v1', graph_revision_change:revisionChange },
    settled_at:'2026-08-31T02:05:00Z',
  });
  assert.deepEqual(restored?.graph_revision_change, revisionChange);
});