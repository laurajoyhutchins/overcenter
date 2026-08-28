import { evaluateProjectGraph } from './project-graph.js';
import { OVERCENTER_PROJECT_DEFINITION_PATH, OVERCENTER_PROJECT_GRAPH_DERIVATION, deriveOvercenterProjectGraph } from './overcenter-project-graph-deriver.js';

function assert(value, message) { if (!value) throw new Error(message); }
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const PROJECT_REF = `github:${REPOSITORY}`;

function definition(transitions) { return JSON.stringify({ schema:'overcenter-project-definition-v1', project_ref:PROJECT_REF, transitions }); }
function facts(content = definition([
  { id:'first', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  { id:'second', priority:5, requires:['first'], executor:{ kind:'operator', command:'example.operator' } },
])) {
  return { schema:'project-definition-facts-v1', repository:REPOSITORY, revision:REVISION, definitions:[{ path:OVERCENTER_PROJECT_DEFINITION_PATH, blob_sha:'a'.repeat(40), sha256:'b'.repeat(64), media_type:'text/plain', content }] };
}
function derive(definitionFacts = facts(), overrides = {}) {
  return deriveOvercenterProjectGraph({ project_ref:PROJECT_REF, authority:{ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION }, facts:{ definition_facts:definitionFacts }, ...overrides });
}
async function failureCode(fn) { try { await fn(); return null; } catch (error) { return error?.code || null; } }

export async function runOvercenterProjectGraphDeriverTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok:true }); } catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); } }

  await test('derives unfinished structural transitions through the canonical graph kernel', async()=>{
    const graph = derive();
    const evaluation = evaluateProjectGraph(graph);
    assert(evaluation.frontier.length === 1 && evaluation.frontier[0].id === 'first', 'root transition was not READY');
    const second = evaluation.nodes.find((node) => node.id === 'second');
    assert(second?.state === 'WAITING' && second.unmet_requirements[0] === 'first', 'dependency was not WAITING');
    assert(graph.nodes.every((node) => Object.keys(node.phase_bindings).length === 0), 'speculative phase protocol leaked into definitions');
  });

  await test('rejects proof or workflow state in repository definitions', async()=>{
    const content = definition([{ id:'first', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' }, proof:{ kind:'issue_closed' } }]);
    assert(await failureCode(()=>derive(facts(content))) === 'OVERCENTER_PROJECT_GRAPH_DERIVATION_INVALID', 'proof mini-language was accepted');
  });

  await test('canonical graph validation rejects missing dependencies and cycles', async()=>{
    assert(await failureCode(()=>derive(facts(definition([{ id:'a', priority:1, requires:['missing'], executor:{ kind:'operator', command:'x' } }]))) !== null, 'missing dependency accepted');
    assert(await failureCode(()=>derive(facts(definition([{ id:'a', priority:1, requires:['b'], executor:{ kind:'operator', command:'x' } },{ id:'b', priority:1, requires:['a'], executor:{ kind:'operator', command:'y' } }]))) !== null, 'cycle accepted');
  });

  await test('fails closed on malformed or stale exact definition facts', async()=>{
    assert(await failureCode(()=>derive(facts('{'))) === 'OVERCENTER_PROJECT_GRAPH_DERIVATION_INVALID', 'malformed JSON accepted');
    assert(await failureCode(()=>derive({ ...facts(), revision:'0'.repeat(40) })) === 'OVERCENTER_PROJECT_GRAPH_DERIVATION_INVALID', 'stale definition revision accepted');
  });

  await test('transition identity and output order are deterministic', async()=>{
    const graph = derive(facts(definition([{ id:'z', priority:1, requires:[], executor:{ kind:'operator', command:'z' } },{ id:'a', priority:1, requires:[], executor:{ kind:'operator', command:'a' } }])));
    assert(graph.nodes.map((node)=>node.id).join(',') === 'a,z', 'nodes were not deterministically ordered');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
