import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrationAdvanceService } from './orchestration-advance.js';

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const DERIVATION = 'overcenter-project-graph-v1';
const LEASE_REF = '11111111-1111-4111-8111-111111111111';
const EXECUTION_INTENT = Object.freeze({
  schema: 'project-execution-intent-v1',
  desired_outcome: 'Verify single-authority agent execution handoff.',
  acceptance_evidence: Object.freeze([
    Object.freeze({ kind: 'verification', requirement: 'Evidence must prove the intended single-authority handoff behavior.' }),
  ]),
  source_ref: 'github:issue:420',
});

function responsibilities() {
  return Object.fromEntries(['ENABLE', 'ACQUIRE', 'EXECUTE', 'COMMIT', 'CONFIRM'].map((stage) => [stage, { applicable: true, satisfied: false }]));
}

function graph() {
  const node = (id, priority) => ({
    id,
    priority,
    requires: [],
    lifecycle: { current_stage: 'ENABLE', condition: 'NOMINAL', responsibilities: responsibilities() },
    executor: { kind: 'agent', role: 'implementation', skill: 'test-driven-development' },
    execution_intent: EXECUTION_INTENT,
    phase_bindings: {},
  });
  return {
    schema: 'project-graph-authority-v1',
    project_ref: PROJECT_REF,
    authority: { definition: { kind: 'github', repository: REPOSITORY, revision: REVISION, derivation: DERIVATION }, observations: [] },
    nodes: [node('first-ready', 20), node('second-ready', 10)],
    horizons: [],
  };
}

test('sequential advance resumes its current agent authority without minting another lease', async () => {
  const acquisitions = [];
  const requirements = [];
  const service = createOrchestrationAdvanceService({
    store: {
      async getRun(runId) {
        return { run_id: runId, status: 'active', target: { project_ref: PROJECT_REF, horizon: { kind: 'project', ref: PROJECT_REF } } };
      },
      async activeLeaseForRun(runId) {
        assert.equal(runId, 'singular-authority-run');
        return { lease_id: LEASE_REF, run_id: runId, status: 'active' };
      },
    },
    readProjectGraph: async () => graph(),
    projectTransitions: {
      async acquire(input) { acquisitions.push(input.transition_id); throw new Error('advance must not acquire while run authority is active'); },
      async require(input) {
        requirements.push(input);
        return {
          ok: true,
          lease_ref: LEASE_REF,
          subject: 'project_transition',
          run_id: 'singular-authority-run',
          project_ref: PROJECT_REF,
          transition_id: 'first-ready',
          repository: REPOSITORY,
          authority: { kind: 'github', repository: REPOSITORY, revision: REVISION, derivation: DERIVATION },
          transition_definition_fingerprint: 'd'.repeat(64),
        };
      },
      async settle() { throw new Error('advance must not settle while existing run authority is active'); },
    },
  });

  const result = await service.advance({ run_id: 'singular-authority-run' });
  assert.equal(result.outcome, 'AGENT_EXECUTION_REQUIRED');
  assert.equal(result.lease_ref, LEASE_REF);
  assert.equal(result.transition?.id, 'first-ready');
  assert.equal(result.authority?.revision, REVISION);
  assert.equal(requirements.length, 1);
  assert.equal(requirements[0].lease_ref, LEASE_REF);
  assert.deepEqual(acquisitions, []);
  assert.deepEqual(result.frontier, ['first-ready', 'second-ready']);
});

test('stale run authority is mechanically requeued before reacquiring the fresh frontier', async () => {
  const reconciliations = [];
  const acquisitions = [];
  const freshLeaseRef = '22222222-2222-4222-8222-222222222222';
  const stale = new Error('project transition authority is stale');
  stale.code = 'PROJECT_TRANSITION_AUTHORITY_STALE';
  const service = createOrchestrationAdvanceService({
    store: {
      async getRun(runId) {
        return { run_id: runId, status: 'active', target: { project_ref: PROJECT_REF, horizon: { kind: 'project', ref: PROJECT_REF } } };
      },
      async activeLeaseForRun() {
        return { lease_id: LEASE_REF, run_id: 'stale-authority-run', status: 'active' };
      },
    },
    readProjectGraph: async () => graph(),
    projectTransitions: {
      async require() { throw stale; },
      async reconcileStale(input) {
        reconciliations.push(input);
        return { ok: true, outcome: 'requeued', lease_ref: LEASE_REF, disposition: 'requeue' };
      },
      async acquire(input) {
        acquisitions.push(input);
        return {
          ok: true,
          lease_ref: freshLeaseRef,
          run_id: 'stale-authority-run',
          project_ref: PROJECT_REF,
          transition_id: input.transition_id,
          authority: { kind: 'github', repository: REPOSITORY, revision: REVISION, derivation: DERIVATION },
          transition_definition_fingerprint: 'f'.repeat(64),
          expires_at: '2099-01-01T00:00:00.000Z',
        };
      },
      async settle() { throw new Error('fresh agent authority must not be settled during handoff'); },
    },
  });

  const result = await service.advance({ run_id: 'stale-authority-run' });
  assert.equal(reconciliations.length, 1);
  assert.equal(reconciliations[0].lease_ref, LEASE_REF);
  assert.equal(reconciliations[0].run_id, 'stale-authority-run');
  assert.equal(acquisitions.length, 1);
  assert.equal(acquisitions[0].transition_id, 'first-ready');
  assert.equal(result.outcome, 'AGENT_EXECUTION_REQUIRED');
  assert.equal(result.lease_ref, freshLeaseRef);
});
