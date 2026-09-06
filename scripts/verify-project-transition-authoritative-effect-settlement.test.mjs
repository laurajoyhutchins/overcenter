import test from 'node:test';
import assert from 'node:assert/strict';

import { projectAdvanceFor } from '../lib/project-advance-overcenter-host.js';

function runtime(options = {}) {
  const projectRef = 'github:laurajoyhutchins/overcenter';
  const transitionId = 'bind-project-transition-settlement-to-authoritative-effect';
  const runId = 'project-advance-authoritative-effect-regression';
  const finishes = [];
  const confirmations = [];
  const host = projectAdvanceFor({
    db:{
      async query(sql) {
        if (String(sql).includes('SELECT run_id,status,target')) {
          return { rows:[{
            run_id:runId,
            status:'active',
            target:{ project_ref:projectRef, horizon:{ kind:'transition', ref:transitionId } },
          }] };
        }
        return { rows:[] };
      },
    },
    runs:{ async start() { throw new Error('resume path must not start a fresh run'); } },
    advance:{ async advance() { throw new Error('settlement path must not advance unrelated work'); } },
    finish:{
      async finish(request) {
        finishes.push(request);
        return { status:'finished', run_id:request.run_id };
      },
    },
    ...(options.confirmAuthoritativeEffect ? {
      confirmAuthoritativeEffect: async (request) => {
        confirmations.push(request);
        return options.confirmAuthoritativeEffect(request);
      },
    } : {}),
  });
  return { host, finishes, confirmations, projectRef, transitionId, runId };
}

const candidateEvidence = [
  { kind:'candidate_revision', ref:'work/example@1111111111111111111111111111111111111111' },
  { kind:'verification', ref:'exact-revision-tests:passed' },
];

test('project.advance rejects candidate-only completion until authoritative repository effect is confirmed', async () => {
  const { host, finishes, projectRef, transitionId, runId } = runtime();

  await assert.rejects(
    host.advance({
      project_ref:projectRef,
      transition_id:transitionId,
      resume_ref:runId,
      execution_result:{ disposition:'completed', evidence:candidateEvidence },
    }),
    (error) => {
      assert.equal(error?.code, 'PROJECT_ADVANCE_AUTHORITATIVE_EFFECT_UNCONFIRMED');
      assert.equal(error?.details?.may_have_mutated, false);
      return true;
    },
  );

  assert.equal(finishes.length, 0, 'candidate-only evidence must never reach completed settlement');
});

test('project.advance does not trust caller-supplied authoritative-effect labels', async () => {
  const { host, finishes, projectRef, transitionId, runId } = runtime();

  await assert.rejects(
    host.advance({
      project_ref:projectRef,
      transition_id:transitionId,
      resume_ref:runId,
      execution_result:{
        disposition:'completed',
        evidence:[...candidateEvidence, { kind:'authority_readback', ref:'github:example/repo@2222222222222222222222222222222222222222' }],
      },
    }),
    (error) => {
      assert.equal(error?.code, 'PROJECT_ADVANCE_AUTHORITATIVE_EFFECT_UNCONFIRMED');
      return true;
    },
  );

  assert.equal(finishes.length, 0, 'unverified evidence labels must never authorize completed settlement');
});

test('project.advance accepts completion only after deterministic authoritative-effect confirmation', async () => {
  const { host, finishes, confirmations, projectRef, transitionId, runId } = runtime({
    confirmAuthoritativeEffect: async () => ({
      confirmed:true,
      evidence:[{ kind:'authority_readback', ref:'github:example/repo@3333333333333333333333333333333333333333' }],
    }),
  });

  const result = await host.advance({
    project_ref:projectRef,
    transition_id:transitionId,
    resume_ref:runId,
    execution_result:{ disposition:'completed', evidence:candidateEvidence },
  });

  assert.equal(result.ok, true);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].run_id, runId);
  assert.equal(finishes.length, 1);
  assert.deepEqual(finishes[0].active_lease_settlement.evidence, [
    ...candidateEvidence,
    { kind:'authority_readback', ref:'github:example/repo@3333333333333333333333333333333333333333' },
  ]);
});