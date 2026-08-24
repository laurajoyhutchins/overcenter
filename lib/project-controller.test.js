import { runProjectControllerTick } from './project-controller.js';
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
    requires:[],
    lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') },
    executor,
  };
}
function completed(nodeValue) {
  return { ...nodeValue, lifecycle:{ current_stage:'CONFIRM', responsibilities:completedResponsibilities() } };
}
function lifecycleRuntime(calls, confirmedGraph, extra = {}) {
  return {
    enable:async (transition) => { calls.push(['ENABLE', transition.node_id]); return { ok:true }; },
    acquire:async (transition) => { calls.push(['ACQUIRE', transition.node_id]); return { ok:true, lease_id:'lease-1' }; },
    commit:async (transition) => { calls.push(['COMMIT', transition.node_id]); return { ok:true }; },
    confirm:async (transition) => { calls.push(['CONFIRM', transition.node_id]); return { ok:true, graph:confirmedGraph }; },
    ...extra,
  };
}

export async function runProjectControllerTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok:true }); } catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); } }

  await test('dispatches the selected operator through the exact registered command', async()=>{
    const calls = [];
    const operatorWork = node('reconcile', 5, { kind:'operator', command:'portfolio.reconcile_work_surface' });
    const agentWork = node('debug', 1, { kind:'agent', role:'debugger', skill:'systematic-debugging' });
    const graph = { nodes:[operatorWork, agentWork] };
    const result = await runProjectControllerTick(graph, lifecycleRuntime(calls, { nodes:[completed(operatorWork), agentWork] }, {
      operators:{
        'portfolio.reconcile_work_surface':async ({ transition }) => {
          calls.push(['OPERATOR', transition.node_id, transition.executor.command]);
          return { ok:true, changed:true };
        },
      },
      executeAgent:async () => { throw new Error('lower-priority agent must not execute'); },
    }));

    assert(result.transition.node_id === 'reconcile', 'controller did not select highest-value transition');
    assert(JSON.stringify(calls) === JSON.stringify([
      ['ENABLE','reconcile'],
      ['ACQUIRE','reconcile'],
      ['OPERATOR','reconcile','portfolio.reconcile_work_surface'],
      ['COMMIT','reconcile'],
      ['CONFIRM','reconcile'],
    ]), 'controller did not route the operator through one lifecycle');
  });

  await test('dispatches an agent transition with its declared role and skill', async()=>{
    const calls = [];
    const agentWork = node('debug', 5, { kind:'agent', role:'debugger', skill:'systematic-debugging' });
    const result = await runProjectControllerTick({ nodes:[agentWork] }, lifecycleRuntime(calls, { nodes:[completed(agentWork)] }, {
      operators:{},
      executeAgent:async ({ role, skill, transition }) => {
        calls.push(['AGENT', transition.node_id, role, skill]);
        return { ok:true, changed:true };
      },
    }));

    assert(result.transition.node_id === 'debug', 'agent transition was not selected');
    assert(JSON.stringify(calls) === JSON.stringify([
      ['ENABLE','debug'],
      ['ACQUIRE','debug'],
      ['AGENT','debug','debugger','systematic-debugging'],
      ['COMMIT','debug'],
      ['CONFIRM','debug'],
    ]), 'controller did not preserve the skill-bound agent descriptor');
  });

  await test('fails before enable when the selected operator is not registered', async()=>{
    const calls = [];
    const operatorWork = node('unknown', 5, { kind:'operator', command:'unknown.command' });
    let code = null;
    try {
      await runProjectControllerTick({ nodes:[operatorWork] }, lifecycleRuntime(calls, { nodes:[completed(operatorWork)] }, {
        operators:{},
        executeAgent:async () => ({ ok:true }),
      }));
    } catch (error) {
      code = error?.code || null;
    }
    assert(code === 'PROJECT_OPERATOR_UNAVAILABLE', 'missing operator did not fail with typed error');
    assert(calls.length === 0, 'lifecycle began before executor availability was established');
  });

  await test('fails before enable when a selected agent has no skill-bound executor', async()=>{
    const calls = [];
    const agentWork = node('debug', 5, { kind:'agent', role:'debugger', skill:'systematic-debugging' });
    let code = null;
    try {
      await runProjectControllerTick({ nodes:[agentWork] }, lifecycleRuntime(calls, { nodes:[completed(agentWork)] }, {
        operators:{},
      }));
    } catch (error) {
      code = error?.code || null;
    }
    assert(code === 'PROJECT_AGENT_EXECUTOR_UNAVAILABLE', 'missing agent executor did not fail with typed error');
    assert(calls.length === 0, 'lifecycle began before agent executor availability was established');
  });

  await test('returns project completion without requiring execution adapters', async()=>{
    const result = await runProjectControllerTick({ nodes:[] }, {});
    assert(result.dispatched === false, 'empty project dispatched a transition');
    assert(result.reason === 'PROJECT_COMPLETE', 'empty project did not resolve as complete');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
