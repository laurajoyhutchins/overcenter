import { executeProjectTransitionLifecycle } from './project-graph.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function assert(value, message) { if (!value) throw new Error(message); }
function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}
function node(id, priority, executor) {
  return {
    id,
    priority,
    requires: [],
    lifecycle: { current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') },
    executor,
  };
}

export async function runProjectDispatchTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({name,ok:true}); } catch (error) { tests.push({name,ok:false,error:String(error?.message||error)}); } }

  await test('does not expose an executor-only dispatch bypass', async()=>{
    const module = await import('./project-graph.js');
    assert(!('dispatchProjectTransition' in module), 'executor-only project dispatch remains publicly callable');
  });

  await test('executes exactly the highest-value ready transition through enable acquire execute commit confirm in order', async()=>{
    const calls = [];
    const result = await executeProjectTransitionLifecycle({ nodes:[
      node('agent-work', 1, { kind:'agent', role:'debugger', skill:'systematic-debugging' }),
      node('operator-work', 5, { kind:'operator', command:'portfolio.reconcile_work_surface' }),
    ] }, {
      enable: async (transition) => { calls.push(['ENABLE', transition.node_id]); return { enabled:true }; },
      acquire: async (transition) => { calls.push(['ACQUIRE', transition.node_id]); return { lease_id:'lease-1' }; },
      operator: async (transition) => { calls.push(['EXECUTE', transition.node_id, transition.executor.command]); return { changed:true }; },
      agent: async (transition) => { calls.push(['EXECUTE_AGENT', transition.node_id, transition.executor.skill]); return { changed:true }; },
      commit: async (transition) => { calls.push(['COMMIT', transition.node_id]); return { commit_sha:'abc123' }; },
      confirm: async (transition) => { calls.push(['CONFIRM', transition.node_id]); return { confirmed:true }; },
    });

    assert(result.dispatched === true, 'transition lifecycle did not dispatch');
    assert(result.transition.node_id === 'operator-work', 'transition lifecycle did not choose the highest-value ready node');
    assert(JSON.stringify(calls) === JSON.stringify([
      ['ENABLE','operator-work'],
      ['ACQUIRE','operator-work'],
      ['EXECUTE','operator-work','portfolio.reconcile_work_surface'],
      ['COMMIT','operator-work'],
      ['CONFIRM','operator-work'],
    ]), 'transition lifecycle did not preserve one five-phase execution path');
    assert(result.phases.CONFIRM.confirmed === true, 'confirm evidence was not returned');
  });

  await test('validates the complete lifecycle handler set before starting a transition', async()=>{
    const calls = [];
    let code = null;
    try {
      await executeProjectTransitionLifecycle({ nodes:[
        node('operator-work', 5, { kind:'operator', command:'portfolio.reconcile_work_surface' }),
      ] }, {
        enable: async () => { calls.push('ENABLE'); },
        acquire: async () => { calls.push('ACQUIRE'); },
        operator: async () => { calls.push('EXECUTE'); },
        confirm: async () => { calls.push('CONFIRM'); },
      });
    } catch (error) {
      code = error?.code || null;
    }
    assert(code === 'PROJECT_LIFECYCLE_HANDLER_UNAVAILABLE', 'missing lifecycle handler did not fail closed');
    assert(calls.length === 0, 'lifecycle began before validating all required handlers');
  });

  await test('returns a typed idle result when no transition is ready', async()=>{
    const result = await executeProjectTransitionLifecycle({ nodes:[] }, {
      enable: async () => { throw new Error('enable should not run'); },
      acquire: async () => { throw new Error('acquire should not run'); },
      operator: async () => { throw new Error('operator should not run'); },
      agent: async () => { throw new Error('agent should not run'); },
      commit: async () => { throw new Error('commit should not run'); },
      confirm: async () => { throw new Error('confirm should not run'); },
    });
    assert(result.dispatched === false, 'empty graph dispatched work');
    assert(result.reason === 'PROJECT_COMPLETE', 'empty graph did not report project completion');
  });

  return { ok:tests.every(test=>test.ok), passed:tests.filter(test=>test.ok).length, failed:tests.filter(test=>!test.ok).length, tests };
}