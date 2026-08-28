import {
  PROJECT_GRAPH_DERIVATION_DECLARATION_PATH,
  normalizeProjectGraphDerivationDeclaration,
  parseProjectGraphDerivationDeclaration,
} from './project-graph-derivation-discovery.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import {
  OVERCENTER_PROJECT_GRAPH_DERIVATION,
  OVERCENTER_PROJECT_DEFINITION_PATH,
  deriveOvercenterProjectGraph,
} from './overcenter-project-graph-deriver.js';

function assert(value, message) { if (!value) throw new Error(message); }
function expectFailure(fn, message) {
  let failed = false;
  try { fn(); } catch { failed = true; }
  assert(failed, message);
}

function definitionFacts() {
  const repository = 'laurajoyhutchins/overcenter';
  const revision = 'a'.repeat(40);
  const content = JSON.stringify({
    schema:'overcenter-project-definition-v1',
    project_ref:'github:laurajoyhutchins/overcenter',
    transitions:[
      { id:'second', priority:10, requires:['first'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
      { id:'first', priority:20, requires:[], executor:{ kind:'operator', command:'test.noop' } },
    ],
  });
  return {
    repository,
    revision,
    facts:{
      schema:'project-definition-facts-v1',
      repository,
      revision,
      definitions:[{
        path:OVERCENTER_PROJECT_DEFINITION_PATH,
        blob_sha:'b'.repeat(40),
        sha256:'c'.repeat(64),
        media_type:'text/plain',
        content,
      }],
    },
  };
}

export async function runProjectGraphDerivationDiscoveryTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('declaration path is fixed under the current Overcenter namespace', async()=>{
    assert(PROJECT_GRAPH_DERIVATION_DECLARATION_PATH === '.overcenter/project-graph.json', 'declaration path changed');
  });

  await test('declaration yields only one registered derivation identity', async()=>{
    const result = normalizeProjectGraphDerivationDeclaration({
      schema:'project-graph-derivation-v1',
      derivation:'overcenter-project-graph-v1',
    });
    assert(result.schema === 'project-graph-derivation-v1', 'schema mismatch');
    assert(result.derivation === 'overcenter-project-graph-v1', 'derivation mismatch');
    assert(Object.keys(result).length === 2, 'declaration retained unsupported authority state');
  });

  await test('JSON declaration parsing is deterministic', async()=>{
    const result = parseProjectGraphDerivationDeclaration('{"schema":"project-graph-derivation-v1","derivation":"overcenter-project-graph-v1"}\n');
    assert(result.derivation === 'overcenter-project-graph-v1', 'parsed derivation mismatch');
  });

  await test('declaration rejects graph state and authority coordinates', async()=>{
    expectFailure(()=>normalizeProjectGraphDerivationDeclaration({ schema:'project-graph-derivation-v1', derivation:'d', nodes:[] }), 'graph nodes were accepted');
    expectFailure(()=>normalizeProjectGraphDerivationDeclaration({ schema:'project-graph-derivation-v1', derivation:'d', repository:'laurajoyhutchins/overcenter' }), 'repository authority was accepted');
    expectFailure(()=>normalizeProjectGraphDerivationDeclaration({ schema:'project-graph-derivation-v1', derivation:'d', revision:'0'.repeat(40) }), 'revision authority was accepted');
  });

  await test('declaration rejects unsupported schema or empty derivation', async()=>{
    expectFailure(()=>normalizeProjectGraphDerivationDeclaration({ schema:'project-graph-derivation-v2', derivation:'d' }), 'unsupported schema accepted');
    expectFailure(()=>normalizeProjectGraphDerivationDeclaration({ schema:'project-graph-derivation-v1', derivation:'' }), 'empty derivation accepted');
  });

  await test('declaration rejects malformed JSON and non-object payloads', async()=>{
    expectFailure(()=>parseProjectGraphDerivationDeclaration('{'), 'malformed JSON accepted');
    expectFailure(()=>parseProjectGraphDerivationDeclaration('[]'), 'array declaration accepted');
    expectFailure(()=>parseProjectGraphDerivationDeclaration(''), 'empty declaration accepted');
  });

  await test('Overcenter derivation maps exact repository definition facts to deterministic graph nodes', async()=>{
    const fixture = definitionFacts();
    const result = deriveOvercenterProjectGraph({
      project_ref:'github:laurajoyhutchins/overcenter',
      authority:{ kind:'github', repository:fixture.repository, revision:fixture.revision, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION },
      facts:{ definition_facts:fixture.facts },
    });
    assert(result.nodes.map((node)=>node.id).join(',') === 'first,second', 'derived node order was not deterministic');
    assert(result.nodes[1].requires.join(',') === 'first', 'dependency edge changed');
    assert(result.nodes[0].lifecycle.current_stage === 'ENABLE', 'deriver invented runtime lifecycle progress');
    assert(result.nodes[0].phase_bindings && Object.keys(result.nodes[0].phase_bindings).length === 0, 'deriver invented phase choreography');
  });

  await test('authoritative reader resolves built-in Overcenter derivation without caller registry bookkeeping', async()=>{
    const fixture = definitionFacts();
    const reader = createAuthoritativeProjectGraphReader({
      resolveProjectAuthority:async()=>({ kind:'github', repository:fixture.repository, revision:fixture.revision, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION }),
      readProjectFacts:async()=>({ schema:'project-authority-facts-v1', repository:fixture.repository, revision:fixture.revision, facts:{ definition_facts:fixture.facts } }),
      readProjectObservations:async()=>[],
    });
    const graph = await reader({ project_ref:'github:laurajoyhutchins/overcenter' });
    assert(graph.nodes.length === 2, 'built-in derivation did not run');
    assert(graph.authority.definition.derivation === OVERCENTER_PROJECT_GRAPH_DERIVATION, 'authority derivation identity changed');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}