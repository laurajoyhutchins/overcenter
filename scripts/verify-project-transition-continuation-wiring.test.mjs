import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { canonicalJson, sha256Text } from '../lib/canonical-json.js';
import { createProjectTransitionLeaseService } from '../lib/project-transition-leases.js';
import { projectTransitionDependencyFingerprint } from '../lib/project-transition-dependency-fingerprint.js';
import { projectTransitionRevisionFingerprint } from '../lib/project-transition-revision-fingerprint.js';
import { PRODUCTIVE_STAGES } from '../lib/work-lifecycle.js';

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}

function graphFixture(transitionOverrides = {}) {
  return {
    schema:'project-graph-authority-v1',
    project_ref:'github:laurajoyhutchins/overcenter',
    authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1'.repeat(40), derivation:'overcenter-project-graph-v1' }, observations:[] },
    nodes:[{
      id:'transition-a',
      priority:1,
      requires:[],
      lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') },
      executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' },
      phase_bindings:{},
      ...transitionOverrides,
    }],
    horizons:[],
  };
}

async function executionFingerprintFor(transition) {
  const revision = await projectTransitionRevisionFingerprint({
    transition_id:transition.id,
    priority:transition.priority,
    executor:transition.executor,
    phase_bindings:transition.phase_bindings,
  });
  const dependency = await projectTransitionDependencyFingerprint({ transition_id:transition.id, requires:transition.requires || [] });
  return sha256Text(canonicalJson({
    schema:'project-transition-execution-fingerprint-v1',
    transition_revision_fingerprint:revision,
    transition_dependency_fingerprint:dependency,
  }));
}

function compactStoreFixture({ graph, continuationFingerprint }) {
  const leases = new Map();
  const slots = new Map();
  const subjectKey = `project_transition:${graph.project_ref}:transition-a`;
  let execution = {
    subject_key:subjectKey,
    subject_kind:'project_transition',
    authority_epoch:3,
    lease_ref:null,
    run_id:null,
    continuation:{ phase:'execute', cursor:7 },
    continuation_sha256:'a'.repeat(64),
    continuation_execution_fingerprint:continuationFingerprint,
    no_progress_streak:2,
  };
  const store = {
    async getRun(id) { return id === 'run-1' ? { run_id:id, status:'active', deadline_at:'2026-09-01T04:00:00Z' } : null; },
    async getLease(id) { return leases.get(id) || null; },
    async getLeaseByAcquireIdempotency(key) { return [...leases.values()].find((row) => row.acquire_idempotency_key === key) || null; },
    async getActiveLeasesForTransition() { return [...leases.values()].filter((row) => row.status === 'active'); },
    async getSlot(key) { return slots.get(key) || null; },
    async getExecutionState(key) { return key === subjectKey ? execution : null; },
    async acquireLeaseAtomically(row) {
      const authorityEpoch = execution.authority_epoch + 1;
      const acquired = { ...row, authority_epoch:authorityEpoch };
      leases.set(row.lease_id, acquired);
      slots.set(row.slot_key, { slot_key:row.slot_key, lease_id:row.lease_id, expires_at:row.expires_at });
      execution = {
        ...execution,
        authority_epoch:authorityEpoch,
        lease_ref:row.lease_id,
        run_id:row.run_id,
        authority_repository:row.repository,
        authority_revision:row.authority_revision,
        transition_revision_fingerprint:row.transition_revision_fingerprint,
        transition_dependency_fingerprint:row.transition_dependency_fingerprint,
        expires_at:row.expires_at,
        hard_expires_at:row.hard_expires_at,
      };
      return acquired;
    },
    async updateLease(id, patch) { const next = { ...leases.get(id), ...patch }; leases.set(id, next); return next; },
    async deleteSlot(key, id) { if (slots.get(key)?.lease_id === id) slots.delete(key); },
  };
  return store;
}

test('project-transition lease runtime derives continuation evidence from the semantic kernel', async () => {
  const source = await readFile(new URL('../lib/project-transition-leases.js', import.meta.url), 'utf8');
  const storeSource = await readFile(new URL('../lib/project-transition-lease-store.js', import.meta.url), 'utf8');

  assert.match(source, /deriveProjectTransitionContinuationEvidence/, 'lease runtime does not consume canonical continuation-evidence derivation');
  assert.doesNotMatch(source, /mutation_scope_unchanged\s*:\s*true/, 'lease runtime still asserts mutation-scope validity outside the semantic kernel');
  assert.match(source, /loadCompactContinuation/, 'lease acquisition does not read the current compact continuation head');
  assert.match(storeSource, /continuation_execution_fingerprint/, 'settlement does not persist the compact continuation execution fingerprint');
  assert.doesNotMatch(storeSource, /work_lease_checkpoints|work_lease_heartbeats/, 'project-transition progress still queries legacy checkpoint or heartbeat history');
});

test('matching compact continuation head is returned directly on acquisition', async () => {
  const graph = graphFixture();
  const fingerprint = await executionFingerprintFor(graph.nodes[0]);
  const store = compactStoreFixture({ graph, continuationFingerprint:fingerprint });
  const service = createProjectTransitionLeaseService({
    store,
    readProjectGraph:async () => graph,
    now:() => '2026-09-01T02:00:00Z',
    uuid:() => '00000000-0000-4000-8000-000000000501',
  });

  const acquired = await service.acquire({
    run_id:'run-1',
    project_ref:graph.project_ref,
    transition_id:'transition-a',
    lease_seconds:600,
    idempotency_key:'compact-continuation-match',
  });

  assert.deepEqual(acquired.continuation?.packet, { phase:'execute', cursor:7 });
  assert.equal(acquired.continuation?.packet_sha256, 'a'.repeat(64));
  assert.equal(acquired.continuation?.execution_fingerprint, fingerprint);
  assert.equal(acquired.continuation?.no_progress_streak, 2);
  assert.equal(acquired.continuation?.stalled_continuation, true);
});

test('compact continuation head is ignored when transition execution semantics changed', async () => {
  const graph = graphFixture();
  const store = compactStoreFixture({ graph, continuationFingerprint:'f'.repeat(64) });
  const service = createProjectTransitionLeaseService({
    store,
    readProjectGraph:async () => graph,
    now:() => '2026-09-01T02:00:00Z',
    uuid:() => '00000000-0000-4000-8000-000000000502',
  });

  const acquired = await service.acquire({
    run_id:'run-1',
    project_ref:graph.project_ref,
    transition_id:'transition-a',
    lease_seconds:600,
    idempotency_key:'compact-continuation-mismatch',
  });

  assert.equal('continuation' in acquired, false);
});
