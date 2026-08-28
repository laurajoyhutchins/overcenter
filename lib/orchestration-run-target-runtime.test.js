import { createPostgresTargetAwareOrchestrationRunService } from './orchestration-run-target-runtime.js';

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
    async getRun(runId) { return runId === 'target-run' ? { run_id:runId, target } : null; },
    async findPredecessorByTarget() { return null; },
    async insertRunWithTarget() { throw new Error('target runtime regression must stay read-only'); },
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

export async function runOrchestrationRunTargetRuntimeTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('target runtime derives an authoritative graph reader from runtime dependencies', async()=>{
    const service = createPostgresTargetAwareOrchestrationRunService({
      db:{},
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
      db:{},
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
      db:{},
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

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
