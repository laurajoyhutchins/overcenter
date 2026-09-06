import test from 'node:test';
import assert from 'node:assert/strict';

import { projectAdvanceFor } from '../lib/project-advance-overcenter-host.js';

function runtime() {
  const projectRef = 'github:laurajoyhutchins/overcenter';
  const transitionId = 'bind-project-transition-settlement-to-authoritative-effect';
  const runId = 'project-advance-authoritative-effect-regression';
  const finishes = [];
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
  });
  return { host, finishes, projectRef, transitionId, runId };
}

test('project.advance rejects candidate-only completion until authoritative repository effect is confirmed', async () => {
  const { host, finishes, projectRef, transitionId, runId } = runtime();

  await assert.rejects(
    host.advance({
      project_ref:projectRef,
      transition_id:transitionId,
      resume_ref:runId,
      execution_result:{
        disposition:'completed',
        evidence:[
          { kind:'candidate_revision', ref:'work/example@1111111111111111111111111111111111111111' },
          { kind:'verification', ref:'exact-revision-tests:passed' },
        ],
      },
    }),
    (error) => {
      assert.equal(error?.code, 'PROJECT_ADVANCE_AUTHORITATIVE_EFFECT_UNCONFIRMED');
      assert.equal(error?.details?.may_have_mutated, false);
      return true;
    },
  );

  assert.equal(finishes.length, 0, 'candidate-only evidence must never reach completed settlement');
});