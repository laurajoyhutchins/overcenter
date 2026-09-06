import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrationAdvanceService } from '../lib/orchestration-advance.js';

function responsibilities(done = false) {
  return Object.fromEntries(['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM'].map((stage) => [stage, { applicable:true, satisfied:done }]));
}

const graph = {
  schema:'project-graph-authority-v1',
  project_ref:'github:laurajoyhutchins/overcenter',
  authority:{ definition:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'a'.repeat(40), derivation:'test-v1' }, observations:[] },
  nodes:[
    { id:'blocked-first', priority:20, requires:[], lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilities() }, executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' }, execution_intent:{ schema:'project-execution-intent-v1', desired_outcome:'blocked first', acceptance_evidence:[{kind:'tests', requirement:'x'}] } },
    { id:'independent-second', priority:10, requires:[], lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilities() }, executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' }, execution_intent:{ schema:'project-execution-intent-v1', desired_outcome:'select second', acceptance_evidence:[{kind:'tests', requirement:'y'}] } },
  ],
  horizons:[],
};

test('project advance skips a durably suspended blocked transition and selects independent READY work', async () => {
  const attempts = [];
  const service = createOrchestrationAdvanceService({
    store:{ async getRun() { return { run_id:'run-1', status:'active', target:{ project_ref:graph.project_ref, horizon:{ kind:'project', ref:graph.project_ref } } }; } },
    readProjectGraph:async () => graph,
    projectTransitions:{
      async acquire(input) {
        attempts.push(input.transition_id);
        if (input.transition_id === 'blocked-first') {
          const error = new Error('transition is durably suspended');
          error.code = 'PROJECT_TRANSITION_SUSPENDED';
          throw error;
        }
        return { lease_ref:'lease-second', transition_definition_fingerprint:'fp', authority:graph.authority.definition, expires_at:'2026-09-06T04:00:00Z' };
      },
      async settle() { throw new Error('not expected'); },
    },
  });

  const result = await service.advance({ run_id:'run-1' });
  assert.deepEqual(attempts, ['blocked-first','independent-second']);
  assert.equal(result.outcome, 'AGENT_EXECUTION_REQUIRED');
  assert.equal(result.transition.id, 'independent-second');
  assert.equal(result.lease_ref, 'lease-second');
});
