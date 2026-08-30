import { createOrchestrationAdvanceService } from './orchestration-advance.js';

function assert(value, message) { if (!value) throw new Error(message); }

const PROJECT_REF = 'github:laurajoyhutchins/overcenter';
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const DERIVATION = 'overcenter-project-graph-v1';

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

  await test('sequential advance never skips an occupied READY transition to mint a second run authority', async()=>{
    const acquisitions = [];
    const service = createOrchestrationAdvanceService({
      store:{
        async getRun(runId) {
          return { run_id:runId, status:'active', target:{ project_ref:PROJECT_REF, horizon:{ kind:'project', ref:PROJECT_REF } } };
        },
      },
      readProjectGraph:async()=>graph(),
      projectTransitions:{
        async acquire(input) {
          acquisitions.push(input.transition_id);
          if (input.transition_id === 'first-ready') {
            const error = new Error('transition already owns execution authority');
            error.code = 'PROJECT_TRANSITION_ALREADY_LEASED';
            throw error;
          }
          return {
            lease_ref:'22222222-2222-4222-8222-222222222222',
            authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:DERIVATION },
            transition_definition_fingerprint:'d'.repeat(64),
            expires_at:'2099-01-01T00:00:00.000Z',
          };
        },
        async settle() { throw new Error('agent transition must not settle during advance'); },
      },
    });

    const result = await service.advance({ run_id:'singular-authority-run' });
    assert(result.outcome === 'WAITING', `occupied sequential frontier should stop boundedly, got ${result.outcome}`);
    assert(JSON.stringify(acquisitions) === JSON.stringify(['first-ready']), `sequential advance attempted another authority: ${acquisitions.join(',')}`);
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
