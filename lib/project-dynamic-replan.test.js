import { executeProjectTransitionLifecycle } from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function assert(value, message) { if (!value) throw new Error(message); }
function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}
function node(id, priority, requires = []) {
  return {
    id,
    priority,
    requires,
    lifecycle:{ current_stage:'EXECUTE', responsibilities:responsibilitiesFor('EXECUTE') },
    executor:{ kind:'operator', command:'github.apply_changeset' },
  };
}

export async function runProjectDynamicReplanTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({name,ok:true}); } catch (error) { tests.push({name,ok:false,error:String(error?.message||error)}); } }

  await test('execution can amend a missing prerequisite and recompute the frontier without committing the blocked transition', async()=>{
    const calls = [];
    const selected = node('implement-runtime', 10);
    const prerequisite = node('establish-schema', 20);
    const replannedSelected = node('implement-runtime', 10, ['establish-schema']);
    const result = await executeProjectTransitionLifecycle({ nodes:[selected] }, {
      enable: async () => { calls.push('ENABLE'); return { ok:true }; },
      acquire: async () => { calls.push('ACQUIRE'); return { ok:true }; },
      operator: async () => {
        calls.push('EXECUTE');
        return {
          ok:true,
          replan:{
            graph:{ nodes:[selected] },
            amendment:{ upsert_nodes:[prerequisite, replannedSelected] },
          },
        };
      },
      commit: async () => { calls.push('COMMIT'); return { ok:true }; },
      confirm: async () => { calls.push('CONFIRM'); return { ok:true, graph:{ nodes:[selected] } }; },
    });

    assert(result.replanned === true, 'dynamic prerequisite discovery did not produce a replan result');
    assert(result.reason === 'PROJECT_GRAPH_REPLANNED', 'dynamic prerequisite discovery did not report a typed replan reason');
    assert(JSON.stringify(calls) === JSON.stringify(['EXECUTE']), 'blocked transition continued into commit or confirm after replanning');
    assert(result.frontier?.length === 1 && result.frontier[0].id === 'establish-schema', 'replanned graph did not enable the missing prerequisite');
    const blocked = result.evaluation?.nodes?.find((entry) => entry.id === 'implement-runtime');
    assert(blocked?.state === 'WAITING', 'selected transition did not become waiting on the discovered prerequisite');
    assert(blocked?.unmet_requirements?.[0] === 'establish-schema', 'selected transition did not retain the discovered dependency');
  });

  return { ok:tests.every(test=>test.ok), passed:tests.filter(test=>test.ok).length, failed:tests.filter(test=>!test.ok).length, tests };
}
