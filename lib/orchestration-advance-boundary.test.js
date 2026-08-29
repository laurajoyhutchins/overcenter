import { CANONICAL_COMMANDS } from './canonical-commands.js';
import { safeRequestProjection, safeResultProjection } from './orchestration-journal.js';
import { createPostgresOrchestrationAdvanceService } from './orchestration-run-target-runtime.js';
import { createSubjectAwareLeaseSettlementService } from './orchestration-finish-runtime.js';
import { executeSemanticWorkerCommand, validateSemanticWorkerCommand } from './worker-transport.js';

function assert(value, message) { if (!value) throw new Error(message); }

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const DERIVATION = 'overcenter-project-graph-v1';

function responsibilities(satisfied = false) {
  return Object.freeze(Object.fromEntries(['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM'].map((stage)=>[
    stage,
    Object.freeze({ applicable:true, satisfied }),
  ])));
}

function graph() {
  return {
    schema:'project-graph-authority-v1',
    project_ref:PROJECT_REF,
    authority:{ definition:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION }, observations:[] },
    nodes:[{
      id:'agent-work', priority:10, requires:[],
      lifecycle:{ current_stage:'ENABLE', condition:'NOMINAL', responsibilities:responsibilities(false) },
      executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' },
      phase_bindings:{},
    }],
    horizons:[],
  };
}

function store() {
  return {
    async getRun(runId) {
      return runId === 'advance-boundary-run'
        ? { run_id:runId, status:'active', target:{ project_ref:PROJECT_REF, horizon:{ kind:'transition', ref:'agent-work' } } }
        : null;
    },
  };
}

function transitions() {
  return {
    async acquire(input) {
      return {
        lease_ref:'55555555-5555-4555-8555-555555555555',
        run_id:input.run_id,
        project_ref:input.project_ref,
        transition_id:input.transition_id,
        transition_definition_fingerprint:'d'.repeat(64),
        authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
        expires_at:'2099-01-01T00:00:00.000Z',
      };
    },
    async settle() { throw new Error('agent boundary must not settle'); },
  };
}

export async function runOrchestrationAdvanceBoundaryTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('orchestration.advance is a canonical semantic command', async()=>{
    assert(CANONICAL_COMMANDS.includes('orchestration.advance'), 'orchestration.advance is missing from the canonical command registry');
  });

  await test('semantic worker boundary accepts only run_id for orchestration.advance', async()=>{
    const valid = validateSemanticWorkerCommand('orchestration.advance', { run_id:'advance-boundary-run' });
    assert(valid.run_id === 'advance-boundary-run', 'advance worker boundary lost run identity');
    for (const forbidden of [
      { project_ref:PROJECT_REF },
      { transition_id:'agent-work' },
      { graph:{ nodes:[] } },
      { frontier:['agent-work'] },
      { lease_ref:'55555555-5555-4555-8555-555555555555' },
    ]) {
      let error = null;
      try { validateSemanticWorkerCommand('orchestration.advance', { run_id:'advance-boundary-run', ...forbidden }); }
      catch (caught) { error = caught; }
      assert(error?.code === 'REQUEST_INVALID', `advance accepted caller-owned field ${Object.keys(forbidden)[0]}`);
    }
  });

  await test('production advance factory composes target store graph reader and project transition leases', async()=>{
    const service = createPostgresOrchestrationAdvanceService({
      db:{ async query() { throw new Error('injected advance dependencies should avoid direct database access'); } },
      store:store(),
      projectGraphReader:async()=>graph(),
      projectTransitions:transitions(),
    });
    const result = await service.advance({ run_id:'advance-boundary-run' });
    assert(result.outcome === 'AGENT_EXECUTION_REQUIRED', 'production advance factory did not expose agent handoff');
    assert(result.lease_ref === '55555555-5555-4555-8555-555555555555', 'production advance factory lost non-secret transition authority');
  });

  await test('semantic worker execution delegates to the production advance service', async()=>{
    const calls = [];
    const response = await executeSemanticWorkerCommand('orchestration.advance', { run_id:'advance-boundary-run' }, {
      orchestrationAdvance:{
        async advance(input) {
          calls.push(input);
          return { ok:true, schema:'orchestration-advance-v1', outcome:'WAITING', run_id:input.run_id, project_ref:PROJECT_REF, frontier:[] };
        },
      },
      logger:{ error() {} },
    });
    assert(response.status === 200 && response.body?.ok === true, 'semantic worker advance did not return command-response success');
    assert(response.body?.outcome === 'WAITING', 'semantic worker advance changed domain outcome');
    assert(calls.length === 1 && calls[0].run_id === 'advance-boundary-run', 'semantic worker advance changed semantic input');
  });

  await test('advance journal projection is bounded and preserves handoff identity without capability material', async()=>{
    const request = safeRequestProjection('orchestration.advance', { run_id:'advance-boundary-run', impossible:'discard-me' });
    const result = safeResultProjection('orchestration.advance', {
      ok:true,
      outcome:'AGENT_EXECUTION_REQUIRED',
      run_id:'advance-boundary-run',
      project_ref:PROJECT_REF,
      transition:{ id:'agent-work', executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
      lease_ref:'55555555-5555-4555-8555-555555555555',
      authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
      frontier:['agent-work'],
      lease_token:'must-not-persist',
    });
    assert(JSON.stringify(request) === JSON.stringify({ run_id:'advance-boundary-run' }), 'advance request projection retained caller noise');
    assert(result.outcome === 'AGENT_EXECUTION_REQUIRED' && result.transition_id === 'agent-work', 'advance result projection lost transition outcome identity');
    assert(result.lease_ref === '55555555-5555-4555-8555-555555555555', 'advance result projection lost non-secret lease reference');
    assert(result.authority?.revision === REVISION, 'advance result projection lost exact graph authority');
    assert(!JSON.stringify(result).includes('must-not-persist'), 'advance result projection leaked capability material');
  });

  await test('finish settlement routes project-transition subjects without consulting legacy work authority', async()=>{
    const calls = { legacy:[], graph:[] };
    const service = createSubjectAwareLeaseSettlementService({
      readLease:async()=>({ lease_id:'graph-lease', run_id:'graph-run', gate:'project_transition', claim_receipt:{ subject:'project_transition' } }),
      legacyLeases:{ async settleByRef(input){ calls.legacy.push(input); throw new Error('graph settlement must not use legacy work authority'); } },
      projectTransitions:{ async settle(input){ calls.graph.push(input); return { ok:true, status:'settled', disposition:input.disposition }; } },
    });
    const result = await service.settleByRef({ lease_ref:'graph-lease', disposition:'requeue', reason:'refresh graph frontier', evidence:[{kind:'graph',ref:'stale'}], idempotency_key:'finish-graph' });
    assert(result.status === 'settled' && calls.graph.length === 1 && calls.legacy.length === 0, 'graph finish settlement did not route exclusively through project transitions');
    assert(calls.graph[0].run_id === 'graph-run' && calls.graph[0].lease_ref === 'graph-lease' && calls.graph[0].disposition === 'requeue', 'graph finish settlement lost durable lease identity');
    assert(!('reason' in calls.graph[0]) && !('evidence' in calls.graph[0]), 'legacy work settlement fields leaked into graph settlement');
  });

  await test('finish settlement preserves the legacy work path and fails closed on ambiguous subject state', async()=>{
    const calls = { legacy:0, graph:0 };
    const legacyLeases={ async settleByRef(input){ calls.legacy += 1; return { ok:true, disposition:input.disposition }; } };
    const projectTransitions={ async settle(){ calls.graph += 1; throw new Error('legacy work must not use project transitions'); } };
    const legacy = createSubjectAwareLeaseSettlementService({
      readLease:async()=>({ lease_id:'legacy-lease', run_id:'legacy-run', gate:'lane:repo-implementation', claim_receipt:{ ownership_protocol:'lease-slot-v2' } }),
      legacyLeases, projectTransitions,
    });
    await legacy.settleByRef({ lease_ref:'legacy-lease', disposition:'requeue', reason:'resume later', idempotency_key:'finish-legacy' });
    assert(calls.legacy === 1 && calls.graph === 0, 'legacy finish settlement changed authority path');

    const ambiguous = createSubjectAwareLeaseSettlementService({
      readLease:async()=>({ lease_id:'ambiguous', run_id:'run', gate:'project_transition', claim_receipt:{ subject:'linear_work' } }),
      legacyLeases, projectTransitions,
    });
    let failure = null;
    try { await ambiguous.settleByRef({ lease_ref:'ambiguous', disposition:'requeue', idempotency_key:'ambiguous' }); }
    catch (error) { failure = error; }
    assert(failure?.code === 'ORCHESTRATION_LEASE_SUBJECT_INVALID', 'ambiguous durable lease subject did not fail closed');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}