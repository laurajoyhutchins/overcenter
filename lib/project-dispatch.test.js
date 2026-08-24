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
    const agentWork = node('agent-work', 1, { kind:'agent', role:'debugger', skill:'systematic-debugging' });
    const operatorWork = node('operator-work', 5, { kind:'operator', command:'portfolio.reconcile_work_surface' });
    const result = await executeProjectTransitionLifecycle({ nodes:[agentWork, operatorWork] }, {
      enable: async (transition) => { calls.push(['ENABLE', transition.node_id]); return { ok:true, enabled:true }; },
      acquire: async (transition) => { calls.push(['ACQUIRE', transition.node_id]); return { ok:true, lease_id:'lease-1' }; },
      operator: async (transition) => { calls.push(['EXECUTE', transition.node_id, transition.executor.command]); return { ok:true, changed:true }; },
      agent: async (transition) => { calls.push(['EXECUTE_AGENT', transition.node_id, transition.executor.skill]); return { ok:true, changed:true }; },
      commit: async (transition) => { calls.push(['COMMIT', transition.node_id]); return { ok:true, commit_sha:'abc123' }; },
      confirm: async (transition) => {
        calls.push(['CONFIRM', transition.node_id]);
        return {
          ok:true,
          confirmed:true,
          graph:{ nodes:[
            agentWork,
            { ...operatorWork, lifecycle:{ current_stage:'CONFIRM', responsibilities:completedResponsibilities() } },
          ] },
        };
      },
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
    assert(result.confirmation.selected.state === 'DONE', 'selected transition was not confirmed done');
  });

  await test('stops the lifecycle when a phase does not explicitly succeed', async()=>{
    const calls = [];
    let code = null;
    let failedPhase = null;
    try {
      await executeProjectTransitionLifecycle({ nodes:[
        node('operator-work', 5, { kind:'operator', command:'portfolio.reconcile_work_surface' }),
      ] }, {
        enable: async () => { calls.push('ENABLE'); return { ok:true, enabled:true }; },
        acquire: async () => { calls.push('ACQUIRE'); return { ok:false, reason:'lease unavailable' }; },
        operator: async () => { calls.push('EXECUTE'); return { ok:true, changed:true }; },
        commit: async () => { calls.push('COMMIT'); return { ok:true, committed:true }; },
        confirm: async () => { calls.push('CONFIRM'); return { ok:true, confirmed:true }; },
      });
    } catch (error) {
      code = error?.code || null;
      failedPhase = error?.details?.phase || null;
    }
    assert(code === 'PROJECT_LIFECYCLE_PHASE_INCOMPLETE', 'negative phase outcome did not fail closed');
    assert(failedPhase === 'ACQUIRE', 'failed phase was not identified');
    assert(JSON.stringify(calls) === JSON.stringify(['ENABLE','ACQUIRE']), 'later phases ran after acquire failed');
  });

  await test('validates the complete lifecycle handler set before starting a transition', async()=>{
    const calls = [];
    let code = null;
    try {
      await executeProjectTransitionLifecycle({ nodes:[
        node('operator-work', 5, { kind:'operator', command:'portfolio.reconcile_work_surface' }),
      ] }, {
        enable: async () => { calls.push('ENABLE'); return { ok:true }; },
        acquire: async () => { calls.push('ACQUIRE'); return { ok:true }; },
        operator: async () => { calls.push('EXECUTE'); return { ok:true }; },
        confirm: async () => { calls.push('CONFIRM'); return { ok:true }; },
      });
    } catch (error) {
      code = error?.code || null;
    }
    assert(code === 'PROJECT_LIFECYCLE_HANDLER_UNAVAILABLE', 'missing lifecycle handler did not fail closed');
    assert(calls.length === 0, 'lifecycle began before validating all required handlers');
  });

  await test('confirmation proves the selected transition is done and recomputes the next frontier', async()=>{
    const source = node('source-work', 5, { kind:'operator', command:'github.apply_changeset' });
    const dependent = {
      ...node('dependent-work', 1, { kind:'operator', command:'github.review_packet' }),
      requires:['source-work'],
    };
    const confirmedGraph = { nodes:[
      {
        ...source,
        lifecycle:{ current_stage:'CONFIRM', responsibilities:completedResponsibilities() },
      },
      dependent,
    ] };

    const result = await executeProjectTransitionLifecycle({ nodes:[source, dependent] }, {
      enable: async () => ({ ok:true }),
      acquire: async () => ({ ok:true }),
      operator: async () => ({ ok:true }),
      commit: async () => ({ ok:true }),
      confirm: async () => ({ ok:true, graph:confirmedGraph }),
    });

    assert(result.confirmation?.selected?.state === 'DONE', 'confirmation did not establish the selected transition as done');
    assert(result.frontier?.length === 1 && result.frontier[0].id === 'dependent-work', 'confirmation did not recompute the next enabled frontier');
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