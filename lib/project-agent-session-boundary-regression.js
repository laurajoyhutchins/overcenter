import { projectAdvanceFor } from './project-advance-overcenter-host.js';
import { createOrchestrationAdvanceService } from './orchestration-advance.js';

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const DERIVATION = 'overcenter-project-graph-v1';
const EXECUTION_INTENT = Object.freeze({
  schema:'project-execution-intent-v1',
  desired_outcome:'Produce the artifact reference packet-only-ok.',
  acceptance_evidence:Object.freeze([
    Object.freeze({ kind:'artifact', requirement:'Evidence must reference the produced artifact.' }),
  ]),
  source_ref:'github:issue:420',
});

function assert(value, message) { if (!value) throw new Error(message); }

function responsibilities(satisfied = false) {
  return Object.freeze(Object.fromEntries(['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM'].map((stage) => [
    stage,
    Object.freeze({ applicable:true, satisfied }),
  ])));
}

function agentNode(id, { priority = 10, requires = [] } = {}) {
  return Object.freeze({
    id,
    priority,
    requires:Object.freeze([...requires]),
    lifecycle:Object.freeze({ current_stage:'ENABLE', condition:'NOMINAL', responsibilities:responsibilities(false) }),
    executor:Object.freeze({ kind:'agent', role:'implementation', skill:'test-driven-development' }),
    execution_intent:EXECUTION_INTENT,
    phase_bindings:Object.freeze({}),
  });
}

function graph(nodes) {
  return Object.freeze({
    schema:'project-graph-authority-v1',
    project_ref:PROJECT_REF,
    authority:Object.freeze({
      definition:Object.freeze({ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION }),
      observations:Object.freeze([]),
    }),
    nodes:Object.freeze(nodes),
    horizons:Object.freeze([]),
  });
}

function projectAdvanceFixture(sessionRefs = []) {
  const starts = [];
  const advances = [];
  let sessionIndex = 0;
  const runs = Object.freeze({
    async start(request) {
      starts.push(request);
      return Object.freeze({ run_id:request.run_id });
    },
  });
  const advance = Object.freeze({
    async advance({ run_id }) {
      advances.push(run_id);
      return Object.freeze({
        ok:true,
        schema:'orchestration-advance-v1',
        outcome:'WAITING',
        run_id,
        project_ref:PROJECT_REF,
        frontier:Object.freeze([]),
      });
    },
  });
  const host = projectAdvanceFor({
    db:{ async query() { throw new Error('session-scoped project.advance should use injected semantic dependencies'); } },
    runs,
    advance,
    newSessionRef:() => sessionRefs[sessionIndex++] || `session-${sessionIndex}`,
    readRun:async()=>null,
  });
  return { host, starts, advances };
}

async function testGenericCallsCreateIndependentSessions() {
  const { host, starts } = projectAdvanceFixture(['session-a', 'session-b']);
  const first = await host.advance({ project_ref:PROJECT_REF });
  const second = await host.advance({ project_ref:PROJECT_REF });
  assert(starts.length === 2, 'unrelated generic project.advance calls reused one active project-wide run');
  assert(first.run_id !== second.run_id, 'unrelated generic project.advance calls received the same run identity');
  assert(first.resume_ref === first.run_id && second.resume_ref === second.run_id, 'project.advance did not expose an explicit durable resume reference');
  assert(starts[0].continuation_key !== starts[1].continuation_key, 'generic project.advance continuation remained project-wide');
  assert(starts.every((request) => request.target?.horizon?.kind === 'project' && request.target.horizon.ref === PROJECT_REF), 'generic project.advance stopped targeting the whole project');
}

async function testExactSelectionCreatesTransitionTarget() {
  const { host, starts } = projectAdvanceFixture(['session-target']);
  await host.advance({ project_ref:PROJECT_REF, transition_id:'target-work' });
  assert(starts.length === 1, 'exact project.advance did not create one independent session');
  assert(starts[0].target?.horizon?.kind === 'transition' && starts[0].target.horizon.ref === 'target-work', 'exact project.advance did not use the authoritative transition horizon');
  assert(starts[0].continuation_key.includes('target-work'), 'exact transition identity is missing from session continuation semantics');
}

async function testExplicitResumeReconnectsExactRun() {
  const starts = [];
  const advances = [];
  const existing = Object.freeze({
    run_id:'project-advance-existing',
    status:'active',
    target:Object.freeze({ project_ref:PROJECT_REF, horizon:Object.freeze({ kind:'transition', ref:'target-work' }) }),
  });
  const host = projectAdvanceFor({
    db:{ async query() { throw new Error('explicit resume should use the injected run reader'); } },
    runs:{ async start(request) { starts.push(request); return request; } },
    advance:{ async advance(input) { advances.push(input); return { ok:true, outcome:'WAITING', run_id:input.run_id, project_ref:PROJECT_REF, frontier:[] }; } },
    readRun:async(runId) => runId === existing.run_id ? existing : null,
    newSessionRef:() => { throw new Error('explicit resume must not allocate a new session'); },
  });
  const result = await host.advance({ project_ref:PROJECT_REF, resume_ref:existing.run_id });
  assert(starts.length === 0, 'explicit project.advance resume created a competing run');
  assert(advances.length === 1 && advances[0].run_id === existing.run_id, 'explicit project.advance resume did not reconnect to the requested run');
  assert(result.resume_ref === existing.run_id, 'explicit resume did not preserve its durable resume reference');
}

async function testExecutionResultTerminatesSessionWithoutStartingAnotherRun() {
  const starts = [];
  const advances = [];
  const finishes = [];
  const existing = Object.freeze({
    run_id:'project-advance-settlement-run',
    status:'active',
    target:Object.freeze({ project_ref:PROJECT_REF, horizon:Object.freeze({ kind:'project', ref:PROJECT_REF }) }),
  });
  const host = projectAdvanceFor({
    db:{ async query() { throw new Error('execution settlement should use injected semantic dependencies'); } },
    runs:{ async start(request) { starts.push(request); return request; } },
    advance:{ async advance(input) { advances.push(input); return { ok:true, outcome:'AGENT_EXECUTION', run_id:input.run_id, project_ref:PROJECT_REF, frontier:[] }; } },
    finish:{
      async finish(input) {
        finishes.push(input);
        return Object.freeze({
          ok:true,
          run_id:input.run_id,
          status:'finished',
          disposition:input.disposition,
          work_authority_changed:true,
        });
      },
    },
    readRun:async(runId) => runId === existing.run_id ? existing : null,
    newSessionRef:() => 'must-not-start-after-settlement',
  });
  const result = await host.advance({
    project_ref:PROJECT_REF,
    resume_ref:existing.run_id,
    execution_result:{
      disposition:'completed',
      evidence:[{ kind:'github_commit', ref:REVISION }],
      reason:'transition completed and verified',
    },
  });
  assert(finishes.length === 1 && finishes[0].run_id === existing.run_id, 'execution_result did not settle the resumed run exactly once');
  assert(starts.length === 0, 'execution_result settlement started a fresh project run');
  assert(advances.length === 0, 'execution_result settlement advanced into unrelated READY work');
  assert(result.run_id === existing.run_id && result.status === 'finished', 'execution_result did not return the terminal settlement result');
  assert(result.resume_ref == null, 'finished project.advance session remained resumable');
}

async function testExactWaitingTargetDoesNotExecutePrerequisite() {
  const acquired = [];
  const service = createOrchestrationAdvanceService({
    store:{ async getRun() { return { run_id:'target-waiting-run', status:'active', target:{ project_ref:PROJECT_REF, horizon:{ kind:'transition', ref:'target-work' } } }; } },
    readProjectGraph:async()=>graph([
      agentNode('prerequisite', { priority:20 }),
      agentNode('target-work', { priority:10, requires:['prerequisite'] }),
    ]),
    projectTransitions:{
      async acquire(input) { acquired.push(input.transition_id); throw new Error('WAITING exact target must not acquire a prerequisite'); },
      async settle() { throw new Error('WAITING exact target must not settle'); },
    },
  });
  const result = await service.advance({ run_id:'target-waiting-run' });
  assert(result.outcome === 'WAITING', `exact WAITING target returned ${result.outcome}`);
  assert(result.transition?.id === 'target-work', 'exact WAITING result lost the requested transition identity');
  assert(JSON.stringify(result.waiting_on || []) === JSON.stringify(['prerequisite']), 'exact WAITING result did not explain its unmet prerequisite');
  assert(acquired.length === 0, 'exact WAITING target silently executed a prerequisite instead');
}

async function testExactOccupiedTargetNeverFallsBack() {
  const acquireCalls = [];
  const service = createOrchestrationAdvanceService({
    store:{ async getRun() { return { run_id:'target-occupied-run', status:'active', target:{ project_ref:PROJECT_REF, horizon:{ kind:'transition', ref:'target-work' } } }; } },
    readProjectGraph:async()=>graph([
      agentNode('target-work', { priority:20 }),
      agentNode('other-work', { priority:10 }),
    ]),
    projectTransitions:{
      async acquire(input) {
        acquireCalls.push(input.transition_id);
        const error = new Error('occupied');
        error.code = 'PROJECT_TRANSITION_ALREADY_LEASED';
        throw error;
      },
      async settle() { throw new Error('occupied exact target must not settle'); },
    },
  });
  const result = await service.advance({ run_id:'target-occupied-run' });
  assert(result.outcome === 'TRANSITION_OCCUPIED', `exact occupied target returned ${result.outcome}`);
  assert(result.transition?.id === 'target-work', 'occupied result lost the exact requested transition');
  assert(JSON.stringify(acquireCalls) === JSON.stringify(['target-work']), 'exact occupied selection silently fell back to unrelated work');
}

function executeFromPacketOnly(packet) {
  const intent = packet?.transition?.execution_intent;
  assert(intent?.schema === 'project-execution-intent-v1', 'agent execution packet omitted canonical execution intent');
  assert(typeof intent.desired_outcome === 'string' && intent.desired_outcome.length > 0, 'packet execution intent omitted desired outcome');
  assert(Array.isArray(intent.acceptance_evidence) && intent.acceptance_evidence.length > 0, 'packet execution intent omitted acceptance evidence requirements');
  const requirement = intent.acceptance_evidence[0];
  const artifactRef = /artifact reference ([a-z0-9-]+)/.exec(intent.desired_outcome)?.[1] || null;
  assert(artifactRef, 'packet desired outcome did not contain enough fixture intent to execute');
  return Object.freeze({
    disposition:'completed',
    evidence:Object.freeze([Object.freeze({ kind:requirement.kind, ref:artifactRef })]),
    reason:intent.desired_outcome,
  });
}

async function testAgentExecutionPacketIsSelfContained() {
  const acquired = [];
  const service = createOrchestrationAdvanceService({
    store:{ async getRun() { return { run_id:'packet-only-run', status:'active', target:{ project_ref:PROJECT_REF, horizon:{ kind:'transition', ref:'packet-only-work' } } }; } },
    readProjectGraph:async()=>graph([agentNode('packet-only-work')]),
    projectTransitions:{
      async acquire(input) {
        acquired.push(input);
        return Object.freeze({
          lease_ref:'packet-only-lease',
          transition_definition_fingerprint:'packet-only-fingerprint',
          authority:Object.freeze({ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION }),
          expires_at:'2099-01-01T00:00:00.000Z',
        });
      },
      async settle() { throw new Error('packet-only fixture should return execution to the disposable agent'); },
    },
  });
  const result = await service.advance({ run_id:'packet-only-run' });
  assert(result.outcome === 'AGENT_EXECUTION_REQUIRED', `packet-only fixture returned ${result.outcome}`);
  assert(acquired.length === 1, 'packet-only fixture did not acquire exactly one transition lease');

  const disposablePacket = JSON.parse(JSON.stringify(result));
  const executionResult = executeFromPacketOnly(disposablePacket);
  assert(executionResult.disposition === 'completed', 'disposable packet execution did not complete');
  assert(executionResult.evidence?.[0]?.kind === 'artifact', 'disposable packet execution lost required evidence kind');
  assert(executionResult.evidence?.[0]?.ref === 'packet-only-ok', 'disposable packet execution required hidden task context');
}

export async function runProjectAgentSessionBoundaryTests() {
  const tests = [];
  for (const [name, fn] of [
    ['generic calls create independent sessions', testGenericCallsCreateIndependentSessions],
    ['exact selection creates transition target', testExactSelectionCreatesTransitionTarget],
    ['explicit resume reconnects exact run', testExplicitResumeReconnectsExactRun],
    ['execution result terminates session without starting another run', testExecutionResultTerminatesSessionWithoutStartingAnotherRun],
    ['exact waiting target does not execute prerequisite', testExactWaitingTargetDoesNotExecutePrerequisite],
    ['exact occupied target never falls back', testExactOccupiedTargetNeverFallsBack],
    ['agent execution packet is self-contained', testAgentExecutionPacketIsSelfContained],
  ]) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }
  const failed = tests.filter((test) => !test.ok);
  if (failed.length) throw new Error(`project agent session boundary regressions failed: ${failed.map((test) => `${test.name}: ${test.error}`).join('; ')}`);
  return { ok:true, tests:tests.length };
}
