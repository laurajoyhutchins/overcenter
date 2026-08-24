import { executeProjectTransitionLifecycle } from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function assert(value, message) { if (!value) throw new Error(message); }
function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}

export async function runProjectLifecycleResumeTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({name,ok:true}); } catch (error) { tests.push({name,ok:false,error:String(error?.message||error)}); } }

  await test('resumes a partially completed transition at its first unresolved lifecycle phase', async()=>{
    const calls = [];
    const result = await executeProjectTransitionLifecycle({ nodes:[{
      id:'resume-commit',
      priority:5,
      requires:[],
      lifecycle:{ current_stage:'COMMIT', responsibilities:responsibilitiesFor('COMMIT') },
      executor:{ kind:'operator', command:'github.apply_changeset' },
    }] }, {
      enable: async () => { calls.push('ENABLE'); return { ok:true, enabled:true }; },
      acquire: async () => { calls.push('ACQUIRE'); return { ok:true, lease_id:'lease-1' }; },
      operator: async () => { calls.push('EXECUTE'); return { ok:true, changed:true }; },
      commit: async () => { calls.push('COMMIT'); return { ok:true, commit_sha:'abc123' }; },
      confirm: async () => { calls.push('CONFIRM'); return { ok:true, confirmed:true }; },
    });

    assert(result.dispatched === true, 'transition was not dispatched');
    assert(result.transition.lifecycle.next_stage === 'COMMIT', 'test fixture did not resolve COMMIT as the first unresolved phase');
    assert(JSON.stringify(calls) === JSON.stringify(['COMMIT','CONFIRM']), 'completed lifecycle phases were replayed instead of resuming from COMMIT');
    assert(!('ENABLE' in result.phases), 'completed ENABLE phase was re-recorded');
    assert(!('ACQUIRE' in result.phases), 'completed ACQUIRE phase was re-recorded');
    assert(!('EXECUTE' in result.phases), 'completed EXECUTE phase was re-recorded');
    assert(result.phases.CONFIRM.confirmed === true, 'confirmation evidence was not returned');
  });

  return { ok:tests.every(test=>test.ok), passed:tests.filter(test=>test.ok).length, failed:tests.filter(test=>!test.ok).length, tests };
}
