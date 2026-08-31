import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectTransitionLeaseService } from '../lib/project-transition-leases.js';
import { PRODUCTIVE_STAGES } from '../lib/work-lifecycle.js';

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}

test('project-transition checkpoint and exact replay preserve current graph revision evidence', async () => {
  const leases = new Map();
  const slots = new Map();
  const checkpoints = new Map();
  const run = { run_id:'run-checkpoint-revision', status:'active', deadline_at:'2026-08-31T04:00:00Z' };
  const store = {
    async getRun(id) { return id === run.run_id ? run : null; },
    async getLease(id) { return leases.get(id) || null; },
    async getLeaseByAcquireIdempotency(key) { return [...leases.values()].find((row) => row.acquire_idempotency_key === key) || null; },
    async getSlot(key) { return slots.get(key) || null; },
    async getActiveLeasesForTransition() { return [...leases.values()].filter((row) => row.status === 'active'); },
    async insertLease(row) { leases.set(row.lease_id, { ...row }); return leases.get(row.lease_id); },
    async insertSlot(row) { slots.set(row.slot_key, { ...row }); return slots.get(row.slot_key); },
    async updateLease(id, patch) { const row = { ...leases.get(id), ...patch }; leases.set(id, row); return row; },
    async deleteSlot(key, id) { if (slots.get(key)?.lease_id === id) slots.delete(key); },
    async getCheckpointByIdempotency(leaseId, key) { return checkpoints.get(`${leaseId}|${key}`) || null; },
    async insertCheckpoint(leaseId, key, requestSha, checkpoint, checkpointSha, createdAt) {
      const row = { lease_id:leaseId, idempotency_key:key, request_sha256:requestSha, checkpoint, checkpoint_sha256:checkpointSha, created_at:createdAt };
      checkpoints.set(`${leaseId}|${key}`, row);
      return row;
    },
  };
  const transition = { id:'transition-a', priority:1, requires:[], lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') }, executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' }, phase_bindings:{} };
  const authority = (revision) => ({ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision, derivation:'overcenter-project-graph-v1' }, observations:[] });
  let graph = { schema:'project-graph-authority-v1', project_ref:'github:laurajoyhutchins/overcenter', authority:authority('1'.repeat(40)), nodes:[transition], horizons:[] };
  const service = createProjectTransitionLeaseService({ store, readProjectGraph:async () => graph, now:() => '2026-08-31T02:00:00Z', uuid:() => '00000000-0000-4000-8000-000000000444' });
  const acquired = await service.acquire({ run_id:run.run_id, project_ref:graph.project_ref, transition_id:transition.id, lease_seconds:600, idempotency_key:'acquire-checkpoint-revision' });
  graph = { ...graph, authority:authority('2'.repeat(40)) };
  const request = { lease_ref:acquired.lease_ref, run_id:run.run_id, checkpoint:{ phase:'execute', next_action_kind:'continue', completed:[], evidence:[] }, idempotency_key:'checkpoint-revision-evidence' };
  const first = await service.checkpoint(request);
  const replayed = await service.checkpoint(request);
  assert.equal(first.graph_revision_change?.current_authority?.revision, '2'.repeat(40));
  assert.equal(first.authority?.revision, '2'.repeat(40));
  assert.equal(replayed.idempotent_replay, true);
  assert.deepEqual(replayed.graph_revision_change, first.graph_revision_change);
});