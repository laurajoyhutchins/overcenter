import test from 'node:test';
import assert from 'node:assert/strict';

import { projectInspectFor } from '../lib/project-inspect-overcenter-host.js';
import { projectInspectForGitHub } from '../lib/project-inspect-github-runtime.js';
import { PRODUCTIVE_STAGES } from '../lib/work-lifecycle.js';

const REVISION = 'a'.repeat(40);

function graph() {
  return {
    schema:'project-graph-authority-v1',
    project_ref:'github:example/project',
    authority:{ definition:{ kind:'github', repository:'example/project', revision:REVISION, derivation:'overcenter-project-graph-v1' } },
    nodes:[
      { id:'blocked-ready', state:'READY', priority:10, requires:[] },
      { id:'occupied-ready', state:'READY', priority:9, requires:[] },
      { id:'free-ready', state:'READY', priority:8, requires:[] },
    ],
  };
}

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}

test('project.inspect reports blocked-settlement suspension as waiting with durable recovery evidence', async () => {
  const observations = [];
  const inspect = projectInspectFor({
    readProjectGraph:async () => graph(),
    evaluateProjectHorizon:() => ({ complete:false, frontier:['blocked-ready','occupied-ready','free-ready'] }),
    now:() => '2026-09-06T08:30:00.000Z',
    readTransitionOccupancy:async (input) => {
      observations.push(input);
      if (input.transition_id === 'blocked-ready') return {
        occupied:false,
        suspended:true,
        suspension_reason:'blocked_settlement_promotion',
        suspension:{
          recovery_ref:'project-transition-suspension:lease-1',
          blocked_lease_ref:'lease-1',
          authority_revision:'b'.repeat(40),
          settled_at:'2026-09-06T08:20:00.000Z',
          reason:'waiting for production convergence',
          conditions:{
            promotion_condition:'production authority reaches the candidate revision',
            release_when:['promotion_condition_satisfied','transition_revision_changes','transition_dependencies_change'],
          },
        },
      };
      if (input.transition_id === 'occupied-ready') return { occupied:true, expires_at:'2026-09-06T08:40:00.000Z', suspended:false };
      return { occupied:false, suspended:false };
    },
  });

  const result = await inspect.inspect({ project_ref:'github:example/project' });
  assert.equal(result.authority_revision, REVISION);
  assert.deepEqual(result.frontier_details, [
    {
      id:'blocked-ready',
      availability:'waiting',
      occupied:false,
      expires_at:null,
      suspended:true,
      wait_reason:'blocked_settlement_promotion',
      suspension:{
        recovery_ref:'project-transition-suspension:lease-1',
        blocked_lease_ref:'lease-1',
        authority_revision:'b'.repeat(40),
        settled_at:'2026-09-06T08:20:00.000Z',
        reason:'waiting for production convergence',
        promotion_condition:'production authority reaches the candidate revision',
        release_when:['promotion_condition_satisfied','transition_revision_changes','transition_dependencies_change'],
      },
    },
    { id:'occupied-ready', availability:'occupied', occupied:true, expires_at:'2026-09-06T08:40:00.000Z', suspended:false, wait_reason:null },
    { id:'free-ready', availability:'available', occupied:false, expires_at:null, suspended:false, wait_reason:null },
  ]);
  assert.equal(observations.length, 3);
  assert.ok(observations.every((entry) => entry.authority_revision === REVISION));
  assert.deepEqual(result.authoring_operations, []);
});

test('project.inspect resolves occupancy for every frontier item beyond the former eight-item projection cap', async () => {
  const frontier = Array.from({ length:9 }, (_, index) => `ready-${index + 1}`);
  const observations = [];
  const inspect = projectInspectFor({
    readProjectGraph:async () => graph(),
    evaluateProjectHorizon:() => ({ complete:false, frontier }),
    now:() => '2026-09-11T12:55:00.000Z',
    readTransitionOccupancy:async (input) => {
      observations.push(input.transition_id);
      if (input.transition_id === 'ready-9') {
        return { occupied:true, expires_at:'2026-09-11T13:05:00.000Z', suspended:false };
      }
      return { occupied:false, suspended:false };
    },
  });

  const result = await inspect.inspect({ project_ref:'github:example/project' });
  assert.deepEqual(observations, frontier);
  assert.deepEqual(result.frontier_details[8], {
    id:'ready-9',
    availability:'occupied',
    occupied:true,
    expires_at:'2026-09-11T13:05:00.000Z',
    suspended:false,
    wait_reason:null,
  });
});

test('project.inspect binds active occupancy and blocked settlement reads to one observation instant', async () => {
  let activeObservedAt = null;
  let settledObservedAt = null;
  const store = {
    async getRun() { return null; },
    async getLease() { return null; },
    async getLeaseByAcquireIdempotency() { return null; },
    async getSlot() { return null; },
    async acquireLeaseAtomically() { throw new Error('not called'); },
    async updateLease() { throw new Error('not called'); },
    async deleteSlot() { throw new Error('not called'); },
    async getActiveLeasesForTransition(projectRef, transitionId, observedAt) {
      assert.equal(projectRef, 'github:example/project');
      assert.equal(transitionId, 'ready-work');
      activeObservedAt = observedAt;
      return [];
    },
    async getLatestSettledLeaseForTransition(projectRef, transitionId, observedAt) {
      assert.equal(projectRef, 'github:example/project');
      assert.equal(transitionId, 'ready-work');
      settledObservedAt = observedAt ?? null;
      return null;
    },
  };
  const operationStore = {
    async get() { return null; },
    async claim() { throw new Error('not called'); },
    async succeed() { throw new Error('not called'); },
    async listByScope() { return []; },
  };
  const lifecycle = { current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') };
  const runtime = {
    async resolveProjectAuthority() {
      return { kind:'github', repository:'example/project', revision:REVISION, derivation:'test-project-graph-v1' };
    },
    async readProjectFacts() {
      return { schema:'project-authority-facts-v1', repository:'example/project', revision:REVISION, facts:{} };
    },
    async readProjectObservations() { return []; },
    projectGraphDerivers:{
      'test-project-graph-v1':async () => ({
        nodes:[{ id:'ready-work', priority:1, requires:[], lifecycle, executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' }, phase_bindings:{} }],
        horizons:[],
      }),
    },
  };
  const inspect = projectInspectForGitHub({
    db:{},
    withGitHubAppApiClient:async () => {},
    createGitHubProjectGraphRuntime:() => runtime,
    createProjectTransitionLeaseStore:() => store,
    createProviderOperationStore:() => operationStore,
  });

  const result = await inspect.inspect({ project_ref:'github:example/project' });
  assert.equal(result.frontier_details[0]?.availability, 'available');
  assert.ok(activeObservedAt, 'active occupancy must be read at a fixed observation instant');
  assert.equal(settledObservedAt, activeObservedAt, 'blocked settlement state must be read at the same observation instant as active occupancy');
});

test('project.inspect projects durable authoring state into a bounded next-action view', async () => {
  const inspect = projectInspectFor({
    readProjectGraph:async () => graph(),
    evaluateProjectHorizon:() => ({ complete:false, frontier:[] }),
    readAuthoringOperations:async () => [{
      operation_id:'op-1',
      idempotency_key:'request-1',
      state:'prepared',
      recovery_payload:{ command:'project.amend', project_ref:'github:example/project', idempotency_key:'request-1', expected_revision:REVISION, staged_revision:'b'.repeat(40), pull_request:721, phase:'WAITING_EXTERNAL_VERIFICATION', waiting_on:['checks'] },
    }],
  });
  const result = await inspect.inspect({ project_ref:'github:example/project' });
  assert.deepEqual(result.authoring_operations, [{ operation_id:'op-1', command:'project.amend', recovery_ref:'project-authoring:github:example/project:request-1', idempotency_key:'request-1', staged_revision:'b'.repeat(40), pull_request:721, waiting_on:['checks'], expected_authority_revision:REVISION, disposition:'waiting_external_verification', automatic_recovery:'reconcile_on_observable_change' }]);
});

test('project.inspect fails closed on ambiguous durable authoring identity', async () => {
  const inspect = projectInspectFor({
    readProjectGraph:async () => graph(),
    evaluateProjectHorizon:() => ({ complete:false, frontier:[] }),
    readAuthoringOperations:async () => [{
      operation_id:'',
      idempotency_key:'request-ambiguous',
      state:'prepared',
      recovery_payload:{ command:'project.amend', project_ref:'github:example/project', idempotency_key:'request-ambiguous', expected_revision:REVISION, staged_revision:'d'.repeat(40), phase:'WAITING_EXTERNAL_VERIFICATION', waiting_on:[] },
    }],
  });
  await assert.rejects(() => inspect.inspect({ project_ref:'github:example/project' }), /ambiguous authoring transaction identity/);
});

test('project.inspect distinguishes authoring authority drift, indeterminate effect, and terminal success', async () => {
  const base = { command:'project.amend', project_ref:'github:example/project', idempotency_key:'request-2', expected_revision:REVISION, staged_revision:'c'.repeat(40), pull_request:null, waiting_on:[] };
  const inspect = projectInspectFor({
    readProjectGraph:async () => graph(),
    evaluateProjectHorizon:() => ({ complete:false, frontier:[] }),
    readAuthoringOperations:async () => [
      { operation_id:'moved', idempotency_key:'request-2', state:'prepared', recovery_payload:{ ...base, phase:'RECOMPUTE_REQUIRED' } },
      { operation_id:'unknown', idempotency_key:'request-2', state:'indeterminate', recovery_payload:{ ...base, phase:'INDETERMINATE_INTEGRATION' } },
      { operation_id:'done', idempotency_key:'request-2', state:'succeeded', resolution:{ authoring:base } },
    ],
  });
  const result = await inspect.inspect({ project_ref:'github:example/project' });
  assert.deepEqual(result.authoring_operations.map((entry) => entry.disposition), ['authority_moved','external_effect_indeterminate','terminal_success']);
  assert.deepEqual(result.authoring_operations.map((entry) => entry.automatic_recovery), ['recompute_candidate','reconcile_external_effect','none']);
});