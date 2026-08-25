import { PRODUCTIVE_STAGES } from './work-lifecycle.js';
import {
  OVERCENTER_PROJECT_GRAPH_DERIVATION,
  PROJECT_GRAPH_DERIVERS,
  deriveOvercenterProjectGraph,
} from './project-graph-deriver.js';

function assert(value, message) {
  if (!value) throw new Error(message);
}

function responsibilitiesFor(target) {
  const index = PRODUCTIVE_STAGES.indexOf(target);
  return Object.fromEntries(PRODUCTIVE_STAGES.map((stage, stageIndex) => [
    stage,
    { applicable:true, satisfied:stageIndex < index },
  ]));
}

function transition(id = 'implement') {
  return {
    id,
    priority:10,
    requires:[],
    lifecycle:{ current_stage:'ENABLE', responsibilities:responsibilitiesFor('ENABLE') },
    executor:{ kind:'operator', command:'portfolio.reconcile_work_surface' },
    phase_bindings:{
      ACQUIRE:{ primitive:'work.claim', evidence:['lease_ref'], input:{ work_ref:{ literal:'linear:LJH-1' } } },
      COMMIT:{ primitive:'github.apply_changeset', evidence:['commit_sha'], input:{ repository:{ literal:'laurajoyhutchins/overcenter' } } },
      CONFIRM:{ primitive:'github.review_packet', evidence:['head_sha'], input:{ repository:{ literal:'laurajoyhutchins/overcenter' } } },
    },
  };
}

export async function runProjectGraphDeriverTests() {
  const tests = [];
  async function test(name, fn) {
    try {
      await fn();
      tests.push({ name, ok:true });
    } catch (error) {
      tests.push({ name, ok:false, error:String(error?.message || error) });
    }
  }

  await test('derives validated transition nodes from exact repository facts', async()=>{
    const result = deriveOvercenterProjectGraph({
      project_ref:'github:laurajoyhutchins/overcenter',
      authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1234567890abcdef1234567890abcdef12345678', derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION },
      facts:{ schema:'overcenter-project-facts-v1', transitions:[transition()] },
    });
    assert(result.schema === 'project-graph-derivation-result-v1', 'derivation result schema is missing');
    assert(result.nodes.length === 1 && result.nodes[0].id === 'implement', 'repository transition was not derived');
  });

  await test('fails closed instead of accepting caller-shaped graph nodes as repository facts', async()=>{
    let code = null;
    try {
      deriveOvercenterProjectGraph({
        project_ref:'github:laurajoyhutchins/overcenter',
        authority:{ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1234567890abcdef1234567890abcdef12345678', derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION },
        facts:{ schema:'overcenter-project-facts-v1', nodes:[transition()] },
      });
    } catch (error) {
      code = error?.code || null;
    }
    assert(code === 'PROJECT_GRAPH_DERIVATION_FACTS_INVALID', 'shadow graph-shaped facts were not rejected');
  });

  await test('registers the production derivation under one stable identifier', async()=>{
    assert(OVERCENTER_PROJECT_GRAPH_DERIVATION === 'overcenter-project-v1', 'production derivation identifier changed');
    assert(PROJECT_GRAPH_DERIVERS[OVERCENTER_PROJECT_GRAPH_DERIVATION] === deriveOvercenterProjectGraph, 'production deriver is not registered');
  });

  return {
    ok:tests.every((entry)=>entry.ok),
    passed:tests.filter((entry)=>entry.ok).length,
    failed:tests.filter((entry)=>!entry.ok).length,
    tests,
  };
}
