import test from 'node:test';
import { executeProjectTransitionLifecycle } from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function assert(value, message) { if (!value) throw new Error(message); }
function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}
function completedResponsibilities() {
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, { applicable:true, satisfied:true }]));
}

test('resumes a partially completed transition at its first unresolved lifecycle phase', async()=>{
    const calls = [];
    const transitionNode = {
      id:'resume-commit',
      priority:5,
      requires:[],
      lifecycle:{ current_stage:'COMMIT', responsibilities:responsibilitiesFor('COMMIT') },
      executor:{ kind:'operator', command:'github.apply_changeset' },
    };
    const result = await executeProjectTransitionLifecycle({ nodes:[transitionNode] }, {
      enable: async () => { calls.push('ENABLE'); return { ok:true, enabled:true }; },
      acquire: async () => { calls.push('ACQUIRE'); return { ok:true, lease_id:'lease-1' }; },
      operator: async () => { calls.push('EXECUTE'); return { ok:true, changed:true }; },
      commit: async () => { calls.push('COMMIT'); return { ok:true, commit_sha:'abc123' }; },
      confirm: async () => {
        calls.push('CONFIRM');
        return {
          ok:true,
          confirmed:true,
          graph:{ nodes:[{
            ...transitionNode,
            lifecycle:{ current_stage:'CONFIRM', responsibilities:completedResponsibilities() },
          }] },
        };
      },
    });

    assert(result.dispatched === true, 'transition was not dispatched');
    assert(result.transition.lifecycle.next_stage === 'COMMIT', 'test fixture did not resolve COMMIT as the first unresolved phase');
    assert(JSON.stringify(calls) === JSON.stringify(['COMMIT','CONFIRM']), 'completed lifecycle phases were replayed instead of resuming from COMMIT');
    assert(!('ENABLE' in result.phases), 'completed ENABLE phase was re-recorded');
    assert(!('ACQUIRE' in result.phases), 'completed ACQUIRE phase was re-recorded');
    assert(!('EXECUTE' in result.phases), 'completed EXECUTE phase was re-recorded');
    assert(result.phases.CONFIRM.confirmed === true, 'confirmation evidence was not returned');
    assert(result.confirmation.selected.state === 'DONE', 'resumed transition was not confirmed done');
    assert(result.frontier.length === 0, 'completed single-node graph exposed an unexpected next frontier');
  });

  // Native node:test owns result aggregation.
