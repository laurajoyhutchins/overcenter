import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectTransitionLeaseService } from '../lib/project-transition-leases.js';
import { PRODUCTIVE_STAGES } from '../lib/execution-lifecycle-contracts.js';

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const TRANSITION_ID = 'ship';
const SLOT_KEY = `project_transition:${PROJECT_REF}:${TRANSITION_ID}`;
const OLD_LEASE = '66666666-6666-4666-8666-666666666666';
const NEW_LEASE = '77777777-7777-4777-8777-777777777777';
const RUN_ID = 'run-recovery';
const OBSERVED_AT = '2026-09-01T21:31:00.000Z';

function responsibilities() {
  return Object.fromEntries(PRODUCTIVE_STAGES.map(stage => [stage, { applicable:true, satisfied:false }]));
}

function graph() {
  return {
    schema:'project-graph-authority-v1',
    project_ref:PROJECT_REF,
    authority:{
      definition:{
        kind:'github',
        repository:REPOSITORY,
        revision:'b'.repeat(40),
        derivation:'overcenter-project-graph-v1',
      },
      observations:[],
    },
    nodes:[{
      id:TRANSITION_ID,
      priority:1,
      requires:[],
      lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilities() },
      executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' },
      phase_bindings:{},
    }],
    horizons:[],
  };
}

function expiredLease() {
  return {
    lease_id:OLD_LEASE,
    subject:'project_transition',
    run_id:'run-old',
    project_ref:PROJECT_REF,
    transition_id:TRANSITION_ID,
    repository:REPOSITORY,
    authority_revision:'b'.repeat(40),
    authority_derivation:'overcenter-project-graph-v1',
    graph_fingerprint:'c'.repeat(64),
    transition_definition_fingerprint:'d'.repeat(64),
    transition_revision_fingerprint:'e'.repeat(64),
    transition_dependency_fingerprint:'f'.repeat(64),
    slot_key:SLOT_KEY,
    status:'active',
    created_at:'2026-09-01T21:00:00.000Z',
    expires_at:'2026-09-01T21:30:00.000Z',
    hard_expires_at:'2026-09-01T22:30:00.000Z',
    acquire_idempotency_key:'old-acquire',
    acquire_request_hash:'1'.repeat(64),
    authority_epoch:1,
  };
}

test('acquire reconciles expired compact authority even when its slot row is already absent', async () => {
  const leases = new Map([[OLD_LEASE, expiredLease()]]);
  let execution = {
    subject_key:SLOT_KEY,
    subject_kind:'project_transition',
    authority_epoch:1,
    lease_ref:OLD_LEASE,
    run_id:'run-old',
    expires_at:'2026-09-01T21:30:00.000Z',
    hard_expires_at:'2026-09-01T22:30:00.000Z',
    transition_revision_fingerprint:'e'.repeat(64),
    transition_dependency_fingerprint:'f'.repeat(64),
    continuation:null,
    continuation_sha256:null,
    continuation_execution_fingerprint:null,
    no_progress_streak:0,
  };
  let reconciliations = 0;

  const store = {
    async getRun(runId) {
      return runId === RUN_ID ? { run_id:RUN_ID, status:'active', deadline_at:'2026-09-01T23:00:00.000Z' } : null;
    },
    async getLease(leaseId) { return leases.get(leaseId) || null; },
    async getLeaseByAcquireIdempotency() { return null; },
    async getActiveLeasesForTransition() { return []; },
    async getSlot() { return null; },
    async getExecutionState(subjectKey) { return subjectKey === SLOT_KEY ? execution : null; },
    async reconcileExpired(subjectKey, leaseId, observedAt) {
      reconciliations += 1;
      assert.equal(subjectKey, SLOT_KEY);
      assert.equal(leaseId, OLD_LEASE);
      assert.equal(observedAt, OBSERVED_AT);
      leases.set(OLD_LEASE, { ...leases.get(OLD_LEASE), status:'expired' });
      execution = { ...execution, lease_ref:null, run_id:null, expires_at:null, hard_expires_at:null };
      return { reason:'PROJECT_TRANSITION_LEASE_EXPIRED' };
    },
    async acquireLeaseAtomically(row) {
      if (execution.lease_ref) {
        const error = new Error('compact authority occupied');
        error.code = 'UNIQUE_VIOLATION';
        throw error;
      }
      execution = {
        ...execution,
        authority_epoch:execution.authority_epoch + 1,
        lease_ref:row.lease_id,
        run_id:row.run_id,
        expires_at:row.expires_at,
        hard_expires_at:row.hard_expires_at,
      };
      const saved = { ...row, authority_epoch:execution.authority_epoch };
      leases.set(saved.lease_id, saved);
      return saved;
    },
    async updateLease() { throw new Error('legacy acquisition path must not run'); },
    async deleteSlot() { return 0; },
  };

  const service = createProjectTransitionLeaseService({
    store,
    readProjectGraph:async () => graph(),
    now:() => OBSERVED_AT,
    uuid:() => NEW_LEASE,
  });

  const acquired = await service.acquire({
    run_id:RUN_ID,
    project_ref:PROJECT_REF,
    transition_id:TRANSITION_ID,
    lease_seconds:600,
    idempotency_key:'recover-slotless-expiry',
  });

  assert.equal(reconciliations, 1);
  assert.equal(leases.get(OLD_LEASE).status, 'expired');
  assert.equal(acquired.lease_ref, NEW_LEASE);
  assert.equal(acquired.authority_epoch, 2);
  assert.equal(execution.lease_ref, NEW_LEASE);
});