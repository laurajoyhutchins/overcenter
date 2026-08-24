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
function node(id, phaseBindings = undefined) {
  return {
    id,
    priority:5,
    requires:[],
    lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') },
    executor:{ kind:'operator', command:'portfolio.reconcile_work_surface' },
    ...(phaseBindings ? { phase_bindings:phaseBindings } : {}),
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

  await test('binds ACQUIRE COMMIT and CONFIRM mechanically to declared Busbar primitives', async()=>{
    const bindings = {
      ACQUIRE:{ primitive:'work.claim', evidence:['lease_ref'] },
      COMMIT:{ primitive:'github.apply_changeset', evidence:['commit_sha'] },
      CONFIRM:{ primitive:'github.review_packet', evidence:['head_sha'] },
    };
    const transition = node('reconcile', bindings);
    const calls = [];
    let reads = 0;
    const runtime = {
      readProjectGraph:async () => {
        reads += 1;
        return { nodes:[reads === 1 ? transition : completed(transition)] };
      },
      primitives:{
        'work.claim':async ({ phase }) => { calls.push([phase,'work.claim']); return { ok:true, lease_ref:'lease-1' }; },
        'github.apply_changeset':async ({ phase }) => { calls.push([phase,'github.apply_changeset']); return { ok:true, commit_sha:'abc123' }; },
        'github.review_packet':async ({ phase }) => { calls.push([phase,'github.review_packet']); return { ok:true, head_sha:'abc123' }; },
      },
      operators:{
        'portfolio.reconcile_work_surface':async () => { calls.push(['EXECUTE','portfolio.reconcile_work_surface']); return { ok:true, changed:true }; },
      },
    };

    const result = await runAuthoritativeProjectControllerTick({ project_ref:'portfolio:primary' }, runtime);
    assert(result.transition.node_id === 'reconcile', 'primitive-bound transition was not dispatched');
    assert(JSON.stringify(calls) === JSON.stringify([
      ['ACQUIRE','work.claim'],
      ['EXECUTE','portfolio.reconcile_work_surface'],
      ['COMMIT','github.apply_changeset'],
      ['CONFIRM','github.review_packet'],
    ]), 'runtime did not bind lifecycle phases to declared primitives');
  });

  await test('resolves declared semantic phase inputs without primitive-specific controller logic', async()=>{
    const bindings = {
      ACQUIRE:{
        primitive:'work.claim',
        evidence:['lease_ref'],
        input:{
          work_ref:{ literal:'linear:LJH-1' },
          run_id:{ literal:'run-1' },
          node_id:{ from:'transition.node_id' },
        },
      },
      COMMIT:{
        primitive:'github.apply_changeset',
        evidence:['commit_sha'],
        input:{
          repository:{ literal:'laurajoyhutchins/busbar' },
          expected_head:{ from:'context.phases.EXECUTE.head_sha' },
        },
      },
      CONFIRM:{
        primitive:'github.review_packet',
        evidence:['head_sha'],
        input:{
          head_sha:{ from:'context.phases.COMMIT.commit_sha' },
        },
      },
    };
    const transition = node('reconcile', bindings);
    const calls = [];
    let reads = 0;
    const runtime = {
      readProjectGraph:async () => {
        reads += 1;
        return { nodes:[reads === 1 ? transition : completed(transition)] };
      },
      primitives:{
        'work.claim':async (input) => { calls.push(['ACQUIRE', input]); return { ok:true, lease_ref:'lease-1' }; },
        'github.apply_changeset':async (input) => { calls.push(['COMMIT', input]); return { ok:true, commit_sha:'commit-1' }; },
        'github.review_packet':async (input) => { calls.push(['CONFIRM', input]); return { ok:true, head_sha:'commit-1' }; },
      },
      operators:{
        'portfolio.reconcile_work_surface':async () => { calls.push(['EXECUTE']); return { ok:true, changed:true, head_sha:'candidate-1' }; },
      },
    };

    const result = await runAuthoritativeProjectControllerTick({ project_ref:'portfolio:primary' }, runtime);
    assert(result.transition.node_id === 'reconcile', 'semantic-input transition was not dispatched');
    assert(JSON.stringify(calls) === JSON.stringify([
      ['ACQUIRE',{ work_ref:'linear:LJH-1', run_id:'run-1', node_id:'reconcile' }],
      ['EXECUTE'],
      ['COMMIT',{ repository:'laurajoyhutchins/busbar', expected_head:'candidate-1' }],
      ['CONFIRM',{ head_sha:'commit-1' }],
    ]), 'phase bindings did not resolve exact semantic primitive inputs');
  });

  await test('fails closed when a bound primitive omits declared evidence', async()=>{
    const transition = node('reconcile', {
      ACQUIRE:{ primitive:'work.claim', evidence:['lease_ref'] },
      COMMIT:{ primitive:'github.apply_changeset', evidence:['commit_sha'] },
      CONFIRM:{ primitive:'github.review_packet', evidence:['head_sha'] },
    });
    let code = null;
    try {
      await runAuthoritativeProjectControllerTick({ project_ref:'portfolio:primary' }, {
        readProjectGraph:async () => ({ nodes:[transition] }),
        primitives:{
          'work.claim':async () => ({ ok:true }),
          'github.apply_changeset':async () => ({ ok:true, commit_sha:'abc123' }),
          'github.review_packet':async () => ({ ok:true, head_sha:'abc123' }),
        },
        operators:{ 'portfolio.reconcile_work_surface':async () => ({ ok:true }) },
      });
    } catch (error) {
      code = error?.code || null;
    }
    assert(code === 'PROJECT_PHASE_EVIDENCE_MISSING', 'missing primitive evidence did not fail closed');
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
