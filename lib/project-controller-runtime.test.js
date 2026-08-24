import { runAuthoritativeProjectControllerTick } from './project-controller-runtime.js';
import { PRODUCTIVE_STAGES } from './work-lifecycle.js';

function assert(value, message) { if (!value) throw new Error(message); }
function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [stage, { applicable:true, satisfied:stageIndex < index }]));
}
function completedResponsibilities() {
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage) => [stage, { applicable:true, satisfied:true }]));
}
function node(id) {
  return {
    id,
    priority:5,
    requires:[],
    lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') },
    executor:{ kind:'operator', command:'portfolio.reconcile_work_surface' },
  };
}
function completed(nodeValue) {
  return { ...nodeValue, lifecycle:{ current_stage:'CONFIRM', responsibilities:completedResponsibilities() } };
}

export async function runProjectControllerRuntimeTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok:true }); } catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); } }

  await test('loads authoritative graph state by project reference and rereads it for confirmation', async()=>{
    const transition = node('reconcile');
    const calls = [];
    let reads = 0;
    const runtime = {
      readProjectGraph:async ({ project_ref }) => {
        calls.push(['READ', project_ref]);
        reads += 1;
        return { nodes:[reads === 1 ? transition : completed(transition)] };
      },
      enable:async () => ({ ok:true }),
      acquire:async () => ({ ok:true, lease_id:'lease-1' }),
      operators:{
        'portfolio.reconcile_work_surface':async () => ({ ok:true, changed:true }),
      },
      commit:async () => ({ ok:true }),
      confirm:async () => ({ ok:true }),
    };

    const result = await runAuthoritativeProjectControllerTick({ project_ref:'portfolio:primary' }, runtime);
    assert(result.transition.node_id === 'reconcile', 'authoritative graph transition was not dispatched');
    assert(JSON.stringify(calls) === JSON.stringify([['READ','portfolio:primary'],['READ','portfolio:primary']]), 'runtime did not reread authoritative graph for confirmation');
  });

  await test('binds exact repository authority through deterministic derivation when no reader is injected', async()=>{
    const transition = node('reconcile');
    const calls = [];
    const revision = '1234567890abcdef1234567890abcdef12345678';
    let factReads = 0;
    const runtime = {
      resolveProjectAuthority:async ({ project_ref }) => {
        calls.push(['RESOLVE', project_ref]);
        return { kind:'github', repository:'laurajoyhutchins/busbar', revision, derivation:'busbar-project-v1' };
      },
      readProjectFacts:async ({ repository, revision:requestedRevision }) => {
        calls.push(['FACTS', repository, requestedRevision]);
        factReads += 1;
        return { schema:'project-authority-facts-v1', repository, revision:requestedRevision, facts:{ complete:factReads > 1 } };
      },
      projectGraphDerivers:{
        'busbar-project-v1':({ facts }) => {
          calls.push(['DERIVE', facts.complete]);
          return { nodes:[facts.complete ? completed(transition) : transition] };
        },
      },
      readProjectObservations:async ({ repository, revision:requestedRevision }) => {
        calls.push(['OBSERVE', repository, requestedRevision]);
        return [{ kind:'github_head', repository, revision:requestedRevision }];
      },
      enable:async () => ({ ok:true }),
      acquire:async () => ({ ok:true, lease_id:'lease-1' }),
      operators:{
        'portfolio.reconcile_work_surface':async () => ({ ok:true, changed:true }),
      },
      commit:async () => ({ ok:true }),
      confirm:async () => ({ ok:true }),
    };

    const result = await runAuthoritativeProjectControllerTick({ project_ref:'portfolio:primary' }, runtime);
    assert(result.transition.node_id === 'reconcile', 'derived authoritative graph transition was not dispatched');
    assert(factReads === 2, 'authoritative facts were not reread for confirmation');
    assert(calls.filter((entry)=>entry[0] === 'RESOLVE').length === 2, 'project authority was not resolved for both reads');
  });

  await test('rejects caller supplied graph state', async()=>{
    let code = null;
    try {
      await runAuthoritativeProjectControllerTick({ project_ref:'portfolio:primary', graph:{ nodes:[] } }, {
        readProjectGraph:async () => ({ nodes:[] }),
      });
    } catch (error) {
      code = error?.code || null;
    }
    assert(code === 'PROJECT_GRAPH_CALLER_AUTHORITY_REJECTED', 'caller-supplied graph state was not rejected');
  });

  await test('fails closed when authoritative graph reader is unavailable', async()=>{
    let code = null;
    try {
      await runAuthoritativeProjectControllerTick({ project_ref:'portfolio:primary' }, {});
    } catch (error) {
      code = error?.code || null;
    }
    assert(code === 'PROJECT_GRAPH_READER_UNAVAILABLE', 'missing graph reader did not fail closed');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
