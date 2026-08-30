import { CANONICAL_COMMANDS } from './canonical-commands.js';
import { safeRequestProjection, safeResultProjection } from './orchestration-journal.js';
import { createPostgresOrchestrationAdvanceService } from './orchestration-run-target-runtime.js';
import { createOrchestrationRunService } from './orchestration-runs.js';
import { createOrchestrationDiagnosisService } from './orchestration-recovery.js';
import { createSubjectAwareActiveLeaseStore, createSubjectAwareLeaseSettlementService } from './orchestration-finish-runtime.js';
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

function deterministicGraph(done = false) {
  return {
    schema:'project-graph-authority-v1',
    project_ref:PROJECT_REF,
    authority:{ definition:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION }, observations:[] },
    nodes:[{
      id:'operator-work', priority:20, requires:[],
      lifecycle:{
        current_stage:done ? 'CONFIRM' : 'ENABLE',
        condition:'NOMINAL',
        responsibilities:responsibilities(done),
      },
      executor:{ kind:'operator', command:'orchestration.maintain' },
      phase_bindings:{},
    }],
    horizons:[],
  };
}

function projectLease(leaseId, revision, createdAt) {
  return {
    lease_id:leaseId,
    work_ref:`project_transition:${PROJECT_REF}:${revision}:reconcile-live-graph-revisions`,
    gate:'project_transition',
    run_id:'finish-authority-run',
    status:'active',
    created_at:createdAt,
    expires_at:'2099-01-01T00:00:00.000Z',
    claim_receipt:{
      subject:'project_transition',
      project_transition:{
        project_ref:PROJECT_REF,
        transition_id:'reconcile-live-graph-revisions',
        repository:REPOSITORY,
        authority_revision:revision,
        authority_derivation:DERIVATION,
        graph_fingerprint:`${revision[0]}`.repeat(64),
        transition_definition_fingerprint:'f'.repeat(64),
      },
    },
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

  await test('production semantic path reaches graph read exact authority operator settlement and fresh confirmation', async()=>{
    const events = [];
    let settled = false;
    let reads = 0;
    const service = createPostgresOrchestrationAdvanceService({
      db:{ async query() { throw new Error('production-path fixture should use injected authoritative dependencies'); } },
      store:{
        async getRun(runId) {
          return runId === 'production-path-run'
            ? { run_id:runId, status:'active', target:{ project_ref:PROJECT_REF, horizon:{ kind:'transition', ref:'operator-work' } } }
            : null;
        },
      },
      projectGraphReader:async()=>{
        reads += 1;
        events.push(`graph:${reads}`);
        return deterministicGraph(settled);
      },
      projectTransitions:{
        async acquire(input) {
          events.push(`acquire:${input.transition_id}`);
          assert(input.run_id === 'production-path-run' && input.project_ref === PROJECT_REF, 'production path lost run/project authority');
          return {
            lease_ref:'66666666-6666-4666-8666-666666666666',
            run_id:input.run_id,
            project_ref:input.project_ref,
            transition_id:input.transition_id,
            transition_definition_fingerprint:'e'.repeat(64),
            authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
            expires_at:'2099-01-01T00:00:00.000Z',
          };
        },
        async settle(input) {
          events.push(`settle:${input.disposition}`);
          assert(input.lease_ref === '66666666-6666-4666-8666-666666666666', 'production path changed exact lease authority');
          assert(input.run_id === 'production-path-run' && input.disposition === 'completed', 'production path settlement semantics changed');
          settled = true;
          return { ok:true, status:'settled', disposition:'completed', settled_at:'2099-01-01T00:00:01.000Z' };
        },
      },
      executeOperator:async(input)=>{
        events.push(`operator:${input.command}`);
        assert(input.command === 'orchestration.maintain', 'production path changed declared operator command');
        assert(input.lease_ref === '66666666-6666-4666-8666-666666666666', 'production path operator lost exact transition authority');
        return { ok:true };
      },
    });
    const response = await executeSemanticWorkerCommand('orchestration.advance', { run_id:'production-path-run' }, {
      orchestrationAdvance:service,
      logger:{ error() {} },
    });
    assert(response.status === 200 && response.body?.outcome === 'TRANSITION_CONFIRMED', 'production semantic entrypoint did not confirm deterministic transition');
    assert(reads === 2, 'production semantic path did not reread authoritative graph for confirmation');
    assert(events.join('|') === 'graph:1|acquire:operator-work|operator:orchestration.maintain|settle:completed|graph:2', `production path order changed: ${events.join('|')}`);
    assert(response.body?.authority?.revision === REVISION, 'production path confirmation lost exact GitHub authority');
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

  await test('finish settles current graph authority and leaves superseded project-transition history non-blocking', async()=>{
    const revisionA = 'a'.repeat(40);
    const revisionB = 'b'.repeat(40);
    const rows = [
      projectLease('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revisionB, '2026-08-29T21:10:00.000Z'),
      projectLease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revisionA, '2026-08-29T21:00:00.000Z'),
    ];
    const run = { run_id:'finish-authority-run', status:'active', worker:'Fast Forward', mode:'interactive' };
    const baseStore = {
      async getRun(){ return run; },
      async activeLeasesForRun(){ return rows.filter((row)=>row.status === 'active'); },
      async activeLeaseForRun(){ throw new Error('authority-aware finish must inspect the candidate set'); },
      async finishRun(_runId, patch){ Object.assign(run, patch); return run; },
      async leasesForRun(){ return rows; },
      async invocationsForRun(){ return []; },
    };
    const settled = [];
    const projectTransitions = {
      async require(input) {
        if (input.lease_ref === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
          const error = new Error('project transition authority changed after lease acquisition');
          error.code = 'PROJECT_TRANSITION_AUTHORITY_STALE';
          throw error;
        }
        return { ok:true, lease_ref:input.lease_ref, subject:'project_transition', run_id:run.run_id, project_ref:PROJECT_REF, transition_id:'reconcile-live-graph-revisions', repository:REPOSITORY, authority:{ kind:'github', repository:REPOSITORY, revision:revisionB, derivation:DERIVATION } };
      },
      async settle(input) {
        settled.push(input.lease_ref);
        const row = rows.find((candidate)=>candidate.lease_id === input.lease_ref);
        row.status = 'settled';
        return { ok:true, status:'settled', disposition:input.disposition };
      },
    };
    const authorityStore = createSubjectAwareActiveLeaseStore({ store:baseStore, projectTransitions });
    const leaseService = createSubjectAwareLeaseSettlementService({
      readLease:async(leaseRef)=>rows.find((row)=>row.lease_id === leaseRef) || null,
      legacyLeases:{ async settleByRef(){ throw new Error('graph regression must not consult legacy settlement'); } },
      projectTransitions,
    });
    const service = createOrchestrationRunService({ store:authorityStore, leases:leaseService, now:()=> '2026-08-29T21:15:00.000Z' });
    const result = await service.finish({
      run_id:run.run_id,
      disposition:'clean-stop',
      stop_reason:'current graph transition settled',
      active_lease_settlement:{ disposition:'requeue', evidence:[] },
    });
    assert(result.status === 'finished' && run.status === 'finished', 'current-authority settlement did not permit terminalization');
    assert(JSON.stringify(settled) === JSON.stringify(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']), 'finish attempted to settle superseded project-transition history');
    assert(rows[1].status === 'active', 'historical lease row was rewritten instead of retained as audit evidence');
  });

  await test('diagnosis reports superseded graph lease as historical without a Linear authority read', async()=>{
    const revisionA = 'a'.repeat(40);
    const lease = projectLease('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revisionA, '2026-08-29T21:00:00.000Z');
    const run = { run_id:'finish-authority-run', status:'active', worker:'Fast Forward', last_work_ref:lease.work_ref, last_gate:'project_transition' };
    let linearReads = 0;
    const store = {
      async getRun(){ return run; },
      async lastSuccessfulInvocation(){ return null; },
      async recentFailures(){ return []; },
      async latestLease(){ return lease; },
      async latestCheckpoint(){ return null; },
      async slot(){ return { lease_id:lease.lease_id, expires_at:lease.expires_at }; },
    };
    const projectTransitions = {
      async require() {
        const error = new Error('project transition authority changed after lease acquisition');
        error.code = 'PROJECT_TRANSITION_AUTHORITY_STALE';
        throw error;
      },
    };
    const diagnosis = await createOrchestrationDiagnosisService({
      store,
      authoritative:{ async getIssue(){ linearReads += 1; throw new Error('graph-native diagnosis must not query Linear'); } },
      projectTransitions,
      now:()=> '2026-08-29T21:15:00.000Z',
    }).diagnose({ run_id:run.run_id });
    assert(linearReads === 0, 'historical graph lease triggered a Linear authority read');
    assert(diagnosis.active_lease === null, 'superseded graph authority remained active in diagnosis');
    assert(diagnosis.latest_lease?.subject === 'project_transition' && diagnosis.latest_lease?.authority_status === 'historical', 'diagnosis did not distinguish historical graph lease authority');
    assert(diagnosis.current_work_state?.subject === 'project_transition' && diagnosis.current_work_state?.authority_status === 'historical', 'diagnosis lost graph-native historical work state');
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