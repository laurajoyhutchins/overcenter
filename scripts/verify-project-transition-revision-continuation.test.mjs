import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectTransitionLeaseService } from '../lib/project-transition-leases.js';
import { reconcileProjectTransitionChange } from '../lib/project-graph-reconciliation.js';
import { PRODUCTIVE_STAGES } from '../lib/work-lifecycle.js';

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}

function graph(revision) {
  return {
    schema:'project-graph-authority-v1',
    project_ref:'github:laurajoyhutchins/overcenter',
    authority:{definition:{kind:'github',repository:'laurajoyhutchins/overcenter',revision,derivation:'overcenter-project-graph-v1'},observations:[]},
    nodes:[{
      id:'transition-a',
      priority:1,
      requires:[],
      lifecycle:{current_stage:'ENABLE',responsibilities:responsibilitiesFor('ENABLE')},
      executor:{kind:'agent',role:'implementation',skill:'test-driven-development'},
      phase_bindings:{},
    }],
    horizons:[],
  };
}

function fixture() {
  let currentGraph = graph('1'.repeat(40));
  let sequence = 0;
  const runs = new Map([
    ['run-1',{run_id:'run-1',status:'active',deadline_at:'2026-08-30T08:00:00Z'}],
    ['run-2',{run_id:'run-2',status:'active',deadline_at:'2026-08-30T08:00:00Z'}],
  ]);
  const leases = new Map();
  const slots = new Map();
  const store = {
    async getRun(id){ return runs.get(id) || null; },
    async getLease(id){ return leases.get(id) || null; },
    async getLeaseByAcquireIdempotency(key){ return [...leases.values()].find((row) => row.acquire_idempotency_key === key) || null; },
    async getActiveLeasesForTransition(projectRef, transitionId, observedAt){
      const observed = Date.parse(observedAt);
      return [...leases.values()].filter((row) => row.project_ref === projectRef && row.transition_id === transitionId && row.status === 'active' && Date.parse(row.expires_at) > observed);
    },
    async getSlot(key){ return slots.get(key) || null; },
    async insertLease(row){ leases.set(row.lease_id,{...row}); return leases.get(row.lease_id); },
    async insertSlot(row){
      if (slots.has(row.slot_key)) {
        const error = new Error('occupied');
        error.code = 'UNIQUE_VIOLATION';
        throw error;
      }
      slots.set(row.slot_key,{...row});
      return slots.get(row.slot_key);
    },
    async updateLease(id,patch){ const row={...leases.get(id),...patch}; leases.set(id,row); return row; },
    async deleteSlot(key,id){ if(slots.get(key)?.lease_id===id) slots.delete(key); },
  };
  const service = createProjectTransitionLeaseService({
    store,
    readProjectGraph:async()=>currentGraph,
    now:()=> '2026-08-30T07:00:00Z',
    uuid:()=> `00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`,
  });
  return { service, setGraph(value){ currentGraph = value; } };
}

async function expectCode(fn, code) {
  await assert.rejects(fn, (error) => error?.code === code);
}

test('unchanged transition authority survives an unrelated authoritative graph revision', async () => {
  const f = fixture();
  const acquired = await f.service.acquire({
    run_id:'run-1',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'transition-a',
    lease_seconds:600,
    idempotency_key:'revision-continuation',
  });

  f.setGraph(graph('2'.repeat(40)));
  const verified = await f.service.require({
    lease_ref:acquired.lease_ref,
    run_id:'run-1',
    repository:'laurajoyhutchins/overcenter',
    transition_id:'transition-a',
  });

  assert.equal(verified.transition_definition_fingerprint, acquired.transition_definition_fingerprint);
  assert.equal(verified.authority.revision, '2'.repeat(40));
  assert.equal(verified.graph_fingerprint.length, 64);
  assert.deepEqual(verified.graph_revision_change, {
    schema:'project-graph-revision-change-v1',
    previous_authority:{
      repository:'laurajoyhutchins/overcenter',
      revision:'1'.repeat(40),
      derivation:'overcenter-project-graph-v1',
    },
    current_authority:{
      repository:'laurajoyhutchins/overcenter',
      revision:'2'.repeat(40),
      derivation:'overcenter-project-graph-v1',
    },
    authority_changed:true,
    changes:[],
  });
});

test('idempotent lease acquisition replay preserves graph revision evidence for targeted resume', async () => {
  const f = fixture();
  const request = {
    run_id:'run-1',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'transition-a',
    lease_seconds:600,
    idempotency_key:'revision-resume',
  };
  const acquired = await f.service.acquire(request);
  f.setGraph(graph('2'.repeat(40)));

  const replayed = await f.service.acquire(request);

  assert.equal(replayed.lease_ref, acquired.lease_ref);
  assert.equal(replayed.idempotent_replay, true);
  assert.equal(replayed.authority.revision, '2'.repeat(40));
  assert.deepEqual(replayed.graph_revision_change, {
    schema:'project-graph-revision-change-v1',
    previous_authority:{
      repository:'laurajoyhutchins/overcenter',
      revision:'1'.repeat(40),
      derivation:'overcenter-project-graph-v1',
    },
    current_authority:{
      repository:'laurajoyhutchins/overcenter',
      revision:'2'.repeat(40),
      derivation:'overcenter-project-graph-v1',
    },
    authority_changed:true,
    changes:[],
  });
});

test('unchanged transition continuation keeps one semantic lease across graph revisions', async () => {
  const f = fixture();
  await f.service.acquire({
    run_id:'run-1',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'transition-a',
    lease_seconds:600,
    idempotency_key:'revision-owner',
  });

  f.setGraph(graph('2'.repeat(40)));
  await expectCode(() => f.service.acquire({
    run_id:'run-2',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'transition-a',
    lease_seconds:600,
    idempotency_key:'revision-contender',
  }), 'PROJECT_TRANSITION_ALREADY_LEASED');
});

test('invalid continuation authority outranks a simultaneous dependency-only change', () => {
  const reconciliation = reconcileProjectTransitionChange(
    { transition_id:'transition-a', definition_fingerprint:'definition-a', dependency_fingerprint:'dependencies-before' },
    { transition_id:'transition-a', definition_fingerprint:'definition-a', dependency_fingerprint:'dependencies-after' },
    { mutation_scope_unchanged:false, required_authority_valid:false },
  );

  assert.equal(reconciliation.kind, 'authority-invalidated');
  assert.equal(reconciliation.may_continue_existing_authority, false);
  assert.equal(reconciliation.may_preserve_confirmation, false);
});
