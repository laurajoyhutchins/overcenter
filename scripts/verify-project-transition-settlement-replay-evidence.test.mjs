import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectTransitionLeaseService } from '../lib/project-transition-leases.js';
import { PRODUCTIVE_STAGES } from '../lib/work-lifecycle.js';

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}

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