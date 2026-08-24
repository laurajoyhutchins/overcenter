import { dispatchProjectTransition, executeProjectTransitionLifecycle } from './project-graph.js';
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

  await test('dispatches exactly the highest-value ready transition through its declared executor kind', async()=>{
    const calls = [];
    const result = await dispatchProjectTransition({ nodes:[
      node('agent-work', 1, { kind:'agent', role:'debugger', skill:'systematic-debugging' }),
      node('operator-work', 5, { kind:'operator', command:'portfolio.reconcile_work_surface' }),
    ] }, {
      operator: async (transition) => { calls.push(['operator', transition.node_id, transition.executor.command]); return { ok:true }; },
      agent: async (transition) => { calls.push(['agent', transition.node_id, transition.executor.skill]); return { ok:true }; },
    });

    assert(result.dispatched === true, 'ready transition was not dispatched');
    assert(result.transition.node_id === 'operator-work', 'dispatcher did not choose the highest-value ready transition');
    assert(JSON.stringify(calls) === JSON.stringify([['operator','operator-work','portfolio.reconcile_work_surface']]), 'dispatcher invoked the wrong executor or invoked more than one executor');
  });

  await test('executes one selected transition through enable acquire execute commit confirm in order', async()=>{
    const calls = [];
    const result = await executeProjectTransitionLifecycle({ nodes:[
      node('operator-work', 5, { kind:'operator', command:'portfolio.reconcile_work_surface' }),
    ] }, {
      enable: async (transition) => { calls.push(['ENABLE', transition.node_id]); return { enabled:true }; },
      acquire: async (transition) => { calls.push(['ACQUIRE', transition.node_id]); return { lease_id:'lease-1' }; },
      operator: async (transition) => { calls.push(['EXECUTE', transition.node_id, transition.executor.command]); return { changed:true }; },
      commit: async (transition) => { calls.push(['COMMIT', transition.node_id]); return { commit_sha:'abc123' }; },
      confirm: async (transition) => { calls.push(['CONFIRM', transition.node_id]); return { confirmed:true }; },
    });

    assert(result.dispatched === true, 'transition lifecycle did not dispatch');
    assert(result.transition.node_id === 'operator-work', 'transition lifecycle selected the wrong node');
    assert(JSON.stringify(calls) === JSON.stringify([
      ['ENABLE','operator-work'],
      ['ACQUIRE','operator-work'],
      ['EXECUTE','operator-work','portfolio.reconcile_work_surface'],
      ['COMMIT','operator-work'],
      ['CONFIRM','operator-work'],
    ]), 'transition lifecycle did not preserve phase order');
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
    const result = await dispatchProjectTransition({ nodes:[] }, {
      operator: async () => { throw new Error('operator should not run'); },
      agent: async () => { throw new Error('agent should not run'); },
    });
    assert(result.dispatched === false, 'empty graph dispatched work');
    assert(result.reason === 'PROJECT_COMPLETE', 'empty graph did not report project completion');
  });

  return { ok:tests.every(test=>test.ok), passed:tests.filter(test=>test.ok).length, failed:tests.filter(test=>!test.ok).length, tests };
}
