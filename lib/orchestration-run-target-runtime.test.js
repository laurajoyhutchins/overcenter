import { createPostgresTargetAwareOrchestrationRunService } from './orchestration-run-target-runtime.js';
import { createOrchestrationAdvanceService } from './orchestration-advance.js';

function assert(value, message) { if (!value) throw new Error(message); }

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const DERIVATION = 'overcenter-project-graph-v1';
const DEFINITION = JSON.stringify({
  schema:'overcenter-project-definition-v1',
  project_ref:PROJECT_REF,
  transitions:[
    { id:'first', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
});

function store() {
  const target = { project_ref:PROJECT_REF, horizon:{ kind:'transition', ref:'first' } };
  return {
    async getRun(runId) { return runId === 'target-run' ? { run_id:runId, status:'active', target } : null; },
    async findPredecessorByTarget() { return null; },
    async insertRunWithTarget() { throw new Error('target runtime regression must stay read-only'); },
  };
}

function observationDb() {
  return {
    async query() { return { rows:[] }; },
  };
}

function graphRuntime() {
  return {
    async resolveProjectAuthority({ project_ref }) {
      assert(project_ref === PROJECT_REF, 'project authority resolved the wrong project');
      return { kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION };
    },
    async readProjectFacts({ repository, revision }) {
      assert(repository === REPOSITORY && revision === REVISION, 'project facts lost exact repository authority');
      return {
        schema:'project-authority-facts-v1',
        repository,
        revision,
        facts:{
          definition_facts:{
            schema:'project-definition-facts-v1',
            repository,
            revision,
            definitions:[{
              path:'.overcenter/definitions/target-architecture.json',
              blob_sha:'a'.repeat(40),
              sha256:'b'.repeat(64),
              media_type:'text/plain',
              content:DEFINITION,
            }],
          },
        },
      };
    },
    async readProjectObservations({ repository, revision }) {
      assert(repository === REPOSITORY && revision === REVISION, 'project observations lost exact repository authority');
      return [];
    },
  };
}

function repositoryFile(content, sha) {
  const bytes = new TextEncoder().encode(content);
  return {
    status:200,
    body:{ type:'file', encoding:'base64', content:btoa(content), size:bytes.length, sha },
  };
}

function productionGitHubTransport() {
  const declaration = JSON.stringify({ schema:'project-graph-derivation-v1', derivation:DERIVATION });
  const discovery = JSON.stringify({ schema:'project-definition-discovery-v1', definitions:['.overcenter/definitions/target-architecture.json'] });
  const calls = [];
  const apiClient = {
    async call(service, request) {
      assert(service === 'github' && request?.method === 'GET', 'production graph reader used a non-read GitHub operation');
      calls.push({ path:request.path, query:request.query || null });
      if (request.path === `/repos/${REPOSITORY}`) return { status:200, body:{ default_branch:'dev' } };
      if (request.path === `/repos/${REPOSITORY}/commits/dev`) return { status:200, body:{ sha:REVISION } };
      if (request.path === `/repos/${REPOSITORY}/commits/${REVISION}`) return { status:200, body:{ sha:REVISION } };
      if (request.path === `/repos/${REPOSITORY}/contents/.overcenter/project-graph.json`) {
        assert(request.query?.ref === REVISION, 'derivation declaration was not bound to exact revision');
        return repositoryFile(declaration, 'c'.repeat(40));
      }
      if (request.path === `/repos/${REPOSITORY}/contents/.overcenter/project-definitions.json`) {
        assert(request.query?.ref === REVISION, 'definition discovery was not bound to exact revision');
        return repositoryFile(discovery, 'd'.repeat(40));
      }
      if (request.path === `/repos/${REPOSITORY}/contents/.overcenter/definitions/target-architecture.json`) {
        assert(request.query?.ref === REVISION, 'project definition was not bound to exact revision');
        return repositoryFile(DEFINITION, 'e'.repeat(40));
      }
      throw new Error(`unexpected GitHub read ${request.path}`);
    },
  };
  return {
    calls,
    async withGitHubAppApiClient(repository, callback, options = {}) {
      assert(repository === REPOSITORY, 'production graph reader requested the wrong repository');
      assert(options.permissionProfile === 'project_facts', 'production graph reader widened GitHub permissions');
      return callback(apiClient);
    },
  };
}

function responsibilities(satisfied = false) {
  return Object.freeze(Object.fromEntries(['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM'].map((stage)=>[
    stage,
    Object.freeze({ applicable:true, satisfied }),
  ])));
}

function authoritativeGraph(nodes) {
  return {
    schema:'project-graph-authority-v1',
    project_ref:PROJECT_REF,
    authority:{
      definition:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
      observations:[],
    },
    nodes,
    horizons:[],
  };
}

function node(id, priority, executor, requires = []) {
  return {
    id,
    priority,
    requires,
    lifecycle:{ current_stage:'ENABLE', condition:'NOMINAL', responsibilities:responsibilities(false) },
    executor,
    phase_bindings:{},
  };
}

function advanceRunStore(target = { project_ref:PROJECT_REF, horizon:{ kind:'project', ref:PROJECT_REF } }) {
  return {
    async getRun(runId) {
      return runId === 'advance-run'
        ? { run_id:runId, status:'active', target, deadline_at:'2099-01-01T00:00:00.000Z' }
        : null;
    },
  };
}

export async function runOrchestrationRunTargetRuntimeTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('target runtime derives an authoritative graph reader from runtime dependencies', async()=>{
    const service = createPostgresTargetAwareOrchestrationRunService({
      db:observationDb(),
      store:store(),
      projectGraphRuntime:graphRuntime(),
    });
    const result = await service.resolveHorizon({ run_id:'target-run' });
    assert(result.ok === true, 'targeted horizon did not resolve');
    assert(result.frontier?.[0]?.id === 'first', 'repository-owned READY transition was not selected');
    assert(result.horizon?.authority?.revision === REVISION, 'horizon lost exact repository revision evidence');
    assert(result.ownership_granted === false && result.work_authority_changed === false, 'read-only horizon resolution gained work authority');
  });

  await test('production target runtime resolves repository-owned graph without caller-built graph dependencies', async()=>{
    const transport = productionGitHubTransport();
    const service = createPostgresTargetAwareOrchestrationRunService({
      db:observationDb(),
      store:store(),
      withGitHubAppApiClient:transport.withGitHubAppApiClient,
    });
    const result = await service.resolveHorizon({ run_id:'target-run' });
    assert(result.ok === true && result.frontier?.[0]?.id === 'first', 'production target runtime did not resolve repository-owned READY work');
    assert(result.horizon?.authority?.repository === REPOSITORY, 'production horizon lost repository authority');
    assert(result.horizon?.authority?.revision === REVISION, 'production horizon lost exact default-branch revision');
    assert(result.horizon?.authority?.derivation === DERIVATION, 'production horizon lost repository-declared derivation');
    assert(result.ownership_granted === false && result.work_authority_changed === false, 'production horizon resolution gained work authority');
    assert(transport.calls.length >= 6, 'production graph reader did not perform the complete exact-revision repository read');
  });

  await test('production target runtime fails closed when definition facts are stale', async()=>{
    const transport = productionGitHubTransport();
    const staleRevision = 'f'.repeat(40);
    const service = createPostgresTargetAwareOrchestrationRunService({
      db:observationDb(),
      store:store(),
      withGitHubAppApiClient:transport.withGitHubAppApiClient,
      readProjectDefinitionFactsWithGitHubApp:async ({ repository, revision })=>({
        schema:'project-definition-facts-v1',
        repository,
        revision:staleRevision,
        definitions:[{
          path:'.overcenter/definitions/target-architecture.json',
          blob_sha:'e'.repeat(40),
          sha256:'f'.repeat(64),
          media_type:'text/plain',
          content:DEFINITION,
        }],
      }),
    });
    let failure = null;
    try { await service.resolveHorizon({ run_id:'target-run' }); }
    catch (error) { failure = error; }
    assert(failure, 'stale definition facts were accepted');
    assert(String(failure.code || '').includes('DERIVATION_INVALID'), 'stale definition facts did not fail at the authoritative graph boundary');
    assert(transport.calls.every((call)=>call.path !== `/repos/${REPOSITORY}/contents/.overcenter/definitions/target-architecture.json`), 'stale-facts characterization unexpectedly performed a second definition read');
  });

  await test('advance returns a bounded non-secret agent execution packet after exact transition acquisition', async()=>{
    const graph = authoritativeGraph([
      node('agent-work', 20, { kind:'agent', role:'implementation', skill:'test-driven-development' }),
    ]);
    const calls = { acquire:[], settle:[] };
    const service = createOrchestrationAdvanceService({
      store:advanceRunStore(),
      readProjectGraph:async()=>graph,
      projectTransitions:{
        async acquire(input) {
          calls.acquire.push(input);
          return {
            lease_ref:'11111111-1111-4111-8111-111111111111',
            subject:'project_transition',
            run_id:input.run_id,
            project_ref:input.project_ref,
            transition_id:input.transition_id,
            transition_definition_fingerprint:'d'.repeat(64),
            authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
            expires_at:'2099-01-01T00:00:00.000Z',
          };
        },
        async settle(input) { calls.settle.push(input); throw new Error('agent handoff must not settle'); },
      },
    });
    const result = await service.advance({ run_id:'advance-run' });
    assert(result.outcome === 'AGENT_EXECUTION_REQUIRED', 'agent transition did not stop at execution handoff');
    assert(result.transition?.id === 'agent-work', 'agent packet lost transition identity');
    assert(result.transition?.executor?.role === 'implementation' && result.transition?.executor?.skill === 'test-driven-development', 'agent packet lost executor contract');
    assert(result.lease_ref === '11111111-1111-4111-8111-111111111111', 'agent packet lost non-secret execution authority reference');
    assert(!JSON.stringify(result).includes('lease_token'), 'agent packet exposed capability-token vocabulary');
    assert(calls.acquire.length === 1 && calls.settle.length === 0, 'agent handoff mutated completion state');
  });

  await test('advance skips occupied READY transitions and selects the next deterministic candidate', async()=>{
    const graph = authoritativeGraph([
      node('occupied', 30, { kind:'agent', role:'implementation', skill:'test-driven-development' }),
      node('available', 20, { kind:'agent', role:'implementation', skill:'test-driven-development' }),
    ]);
    const attempts = [];
    const service = createOrchestrationAdvanceService({
      store:advanceRunStore(),
      readProjectGraph:async()=>graph,
      projectTransitions:{
        async acquire(input) {
          attempts.push(input.transition_id);
          if (input.transition_id === 'occupied') throw Object.assign(new Error('occupied'), { code:'PROJECT_TRANSITION_ALREADY_LEASED' });
          return {
            lease_ref:'22222222-2222-4222-8222-222222222222',
            run_id:input.run_id,
            project_ref:input.project_ref,
            transition_id:input.transition_id,
            transition_definition_fingerprint:'e'.repeat(64),
            authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
            expires_at:'2099-01-01T00:00:00.000Z',
          };
        },
        async settle() { throw new Error('agent candidate must not settle'); },
      },
    });
    const result = await service.advance({ run_id:'advance-run' });
    assert(attempts.join(',') === 'occupied,available', 'advance did not own deterministic contention handling');
    assert(result.outcome === 'AGENT_EXECUTION_REQUIRED' && result.transition?.id === 'available', 'advance did not return the next eligible transition');
  });

  await test('advance returns WAITING when every READY transition is already occupied', async()=>{
    const graph = authoritativeGraph([
      node('occupied-a', 30, { kind:'agent', role:'implementation', skill:'test-driven-development' }),
      node('occupied-b', 20, { kind:'agent', role:'implementation', skill:'test-driven-development' }),
    ]);
    const service = createOrchestrationAdvanceService({
      store:advanceRunStore(),
      readProjectGraph:async()=>graph,
      projectTransitions:{
        async acquire() { throw Object.assign(new Error('occupied'), { code:'PROJECT_TRANSITION_ALREADY_LEASED' }); },
        async settle() { throw new Error('occupied frontier must not settle'); },
      },
    });
    const result = await service.advance({ run_id:'advance-run' });
    assert(result.outcome === 'WAITING', 'fully occupied frontier did not return WAITING');
    assert(Array.isArray(result.frontier) && result.frontier.join(',') === 'occupied-a,occupied-b', 'WAITING lost authoritative frontier evidence');
  });

  await test('advance completes a deterministic operator only after settlement is visible in a fresh graph read', async()=>{
    const ready = authoritativeGraph([
      node('operator-work', 20, { kind:'operator', command:'orchestration.maintain' }),
    ]);
    const completed = authoritativeGraph([{
      ...ready.nodes[0],
      lifecycle:{ current_stage:'CONFIRM', condition:'NOMINAL', responsibilities:responsibilities(true) },
    }]);
    let reads = 0;
    const calls = { operator:[], settle:[] };
    const service = createOrchestrationAdvanceService({
      store:advanceRunStore(),
      readProjectGraph:async()=>{ reads += 1; return reads === 1 ? ready : completed; },
      executeOperator:async(input)=>{ calls.operator.push(input); return { ok:true, evidence:[{ kind:'test', ref:'operator-ok' }] }; },
      projectTransitions:{
        async acquire(input) {
          return {
            lease_ref:'33333333-3333-4333-8333-333333333333',
            run_id:input.run_id,
            project_ref:input.project_ref,
            transition_id:input.transition_id,
            transition_definition_fingerprint:'f'.repeat(64),
            authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
            expires_at:'2099-01-01T00:00:00.000Z',
          };
        },
        async settle(input) { calls.settle.push(input); return { status:'settled', disposition:'completed', lease_ref:input.lease_ref }; },
      },
    });
    const result = await service.advance({ run_id:'advance-run' });
    assert(calls.operator.length === 1 && calls.operator[0]?.command === 'orchestration.maintain', 'deterministic operator did not use the declared canonical command');
    assert(calls.operator[0]?.lease_ref === '33333333-3333-4333-8333-333333333333', 'operator lost exact transition authority');
    assert(calls.settle.length === 1 && calls.settle[0]?.disposition === 'completed', 'deterministic completion did not settle exact transition authority');
    assert(reads >= 2, 'deterministic completion did not reread authoritative graph state');
    assert(result.outcome === 'TRANSITION_CONFIRMED' && result.transition?.id === 'operator-work', 'confirmed deterministic transition was not reported');
  });

  await test('advance fails closed when deterministic settlement is not observable as DONE', async()=>{
    const graph = authoritativeGraph([
      node('operator-work', 20, { kind:'operator', command:'orchestration.maintain' }),
    ]);
    const service = createOrchestrationAdvanceService({
      store:advanceRunStore(),
      readProjectGraph:async()=>graph,
      executeOperator:async()=>({ ok:true, evidence:[{ kind:'test', ref:'operator-ok' }] }),
      projectTransitions:{
        async acquire(input) {
          return {
            lease_ref:'44444444-4444-4444-8444-444444444444',
            run_id:input.run_id,
            project_ref:input.project_ref,
            transition_id:input.transition_id,
            transition_definition_fingerprint:'a'.repeat(64),
            authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
            expires_at:'2099-01-01T00:00:00.000Z',
          };
        },
        async settle(input) { return { status:'settled', disposition:'completed', lease_ref:input.lease_ref }; },
      },
    });
    let failure = null;
    try { await service.advance({ run_id:'advance-run' }); } catch (error) { failure = error; }
    assert(failure?.code === 'ORCHESTRATION_ADVANCE_CONFIRMATION_UNPROVEN', 'advance accepted an unproven deterministic completion');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
