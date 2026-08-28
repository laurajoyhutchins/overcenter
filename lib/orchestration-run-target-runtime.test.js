import { createPostgresTargetAwareOrchestrationRunService } from './orchestration-run-target-runtime.js';

function assert(value, message) { if (!value) throw new Error(message); }

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const DERIVATION = 'overcenter-project-graph-v1';

function store() {
  const target = { project_ref:PROJECT_REF, horizon:{ kind:'transition', ref:'first' } };
  return {
    async getRun(runId) { return runId === 'target-run' ? { run_id:runId, target } : null; },
    async findPredecessorByTarget() { return null; },
    async insertRunWithTarget() { throw new Error('target runtime regression must stay read-only'); },
  };
}

function graphRuntime() {
  const definition = JSON.stringify({
    schema:'overcenter-project-definition-v1',
    project_ref:PROJECT_REF,
    transitions:[
      { id:'first', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  });
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
              content:definition,
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

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
