import { createOrchestrationAdvanceService } from './orchestration-advance.js';

function assert(value, message) { if (!value) throw new Error(message); }

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const DERIVATION = 'overcenter-project-graph-v1';
const LEASE_REF = '11111111-1111-4111-8111-111111111111';

function responsibilities() {
  return Object.fromEntries(['ENABLE','ACQUIRE','EXECUTE','COMMIT','CONFIRM'].map((stage) => [stage, { applicable:true, satisfied:false }]));
}

function graph() {
  const node = (id, priority) => ({
    id,
    priority,
    requires:[],
    lifecycle:{ current_stage:'ENABLE', condition:'NOMINAL', responsibilities:responsibilities() },
    executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' },
    phase_bindings:{},
  });
  return {
    schema:'project-graph-authority-v1',
    project_ref:PROJECT_REF,
    authority:{ definition:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION }, observations:[] },
    nodes:[node('first-ready', 20), node('second-ready', 10)],
    horizons:[],
  };
}

export async function runOrchestrationAdvanceSingleAuthorityTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('sequential advance resumes its current agent authority without minting another lease', async()=>{
    const acquisitions = [];
    const requirements = [];
    const service = createOrchestrationAdvanceService({
      store:{
        async getRun(runId) {
          return { run_id:runId, status:'active', target:{ project_ref:PROJECT_REF, horizon:{ kind:'project', ref:PROJECT_REF } } };
        },
        async activeLeaseForRun(runId) {
          assert(runId === 'singular-authority-run', 'active authority lookup used the wrong run');
          return { lease_id:LEASE_REF, run_id:runId, status:'active' };
        },
      },
      readProjectGraph:async()=>graph(),
      projectTransitions:{
        async acquire(input) { acquisitions.push(input.transition_id); throw new Error('advance must not acquire while run authority is active'); },
        async require(input) {
          requirements.push(input);
          return {
            ok:true,
            lease_ref:LEASE_REF,
            subject:'project_transition',
            run_id:'singular-authority-run',
            project_ref:PROJECT_REF,
            transition_id:'first-ready',
            repository:REPOSITORY,
            authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
            transition_definition_fingerprint:'d'.repeat(64),
          };
        },
        async settle() { throw new Error('advance must not settle while existing run authority is active'); },
      },
    });

    const result = await service.advance({ run_id:'singular-authority-run' });
    assert(result.outcome === 'AGENT_EXECUTION_REQUIRED', `current agent authority should be resumed, got ${result.outcome}`);
    assert(result.lease_ref === LEASE_REF, 'resumed handoff did not preserve the existing lease reference');
    assert(result.transition?.id === 'first-ready', 'resumed handoff lost the authoritative transition');
    assert(result.authority?.revision === REVISION, 'resumed handoff lost exact GitHub authority');
    assert(requirements.length === 1 && requirements[0].lease_ref === LEASE_REF, 'existing lease was not canonically revalidated');
    assert(acquisitions.length === 0, `sequential advance attempted a second authority: ${acquisitions.join(',')}`);
    assert(result.frontier.join(',') === 'first-ready,second-ready', 'resumed handoff lost authoritative frontier evidence');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
