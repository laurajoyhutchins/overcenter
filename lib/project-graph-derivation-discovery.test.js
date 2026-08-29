import { canonicalJson, sha256Text } from './canonical-json.js';
import {
  PROJECT_GRAPH_DERIVATION_DECLARATION_PATH,
  normalizeProjectGraphDerivationDeclaration,
  parseProjectGraphDerivationDeclaration,
} from './project-graph-derivation-discovery.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { evaluateProjectGraph } from './project-graph.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { prepareProjectTransitionLeasePersistence } from './project-transition-lease-store.js';
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
      { id:'first', priority:20, requires:[], executor:{ kind:'operator', command:'github.review_packet' } },
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

async function transitionFingerprint(node) {
  return sha256Text(canonicalJson({
    id:node.id,
    priority:node.priority,
    requires:node.requires,
    executor:node.executor,
    phase_bindings:node.phase_bindings,
  }));
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
    const derived = deriveOvercenterProjectGraph({
      project_ref:'github:laurajoyhutchins/overcenter',
      authority:{ kind:'github', repository:fixture.repository, revision:fixture.revision, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION },
      facts:{ definition_facts:fixture.facts },
    });
    const reader = createAuthoritativeProjectGraphReader({
      resolveProjectAuthority:async()=>({ kind:'github', repository:fixture.repository, revision:fixture.revision, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION }),
      readProjectFacts:async()=>({ schema:'project-authority-facts-v1', repository:fixture.repository, revision:fixture.revision, facts:{ definition_facts:fixture.facts } }),
      readProjectObservations:async()=>[],
    });
    const graph = await reader({ project_ref:'github:laurajoyhutchins/overcenter' });
    assert(graph.nodes.length === 2, 'built-in derivation did not run');
    assert(graph.authority.definition.derivation === OVERCENTER_PROJECT_GRAPH_DERIVATION, 'authority derivation identity changed');
    assert(JSON.stringify(graph.nodes) === JSON.stringify(derived.nodes), 'empty observations changed the freshly derived graph');
  });

  await test('compatible completed transition observation marks predecessor DONE across unrelated repository revisions', async()=>{
    const fixture = definitionFacts();
    const derived = deriveOvercenterProjectGraph({
      project_ref:'github:laurajoyhutchins/overcenter',
      authority:{ kind:'github', repository:fixture.repository, revision:fixture.revision, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION },
      facts:{ definition_facts:fixture.facts },
    });
    const first = derived.nodes.find((node)=>node.id === 'first');
    const fingerprint = await transitionFingerprint(first);
    const reader = createAuthoritativeProjectGraphReader({
      resolveProjectAuthority:async()=>({ kind:'github', repository:fixture.repository, revision:fixture.revision, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION }),
      readProjectFacts:async()=>({ schema:'project-authority-facts-v1', repository:fixture.repository, revision:fixture.revision, facts:{ definition_facts:fixture.facts } }),
      readProjectObservations:async()=>[{
        schema:'project-transition-observation-v1',
        kind:'project_transition_confirmation',
        project_ref:'github:laurajoyhutchins/overcenter',
        transition_id:'first',
        transition_definition_fingerprint:fingerprint,
        disposition:'completed',
        authority:{ kind:'github', repository:fixture.repository, revision:'9'.repeat(40), derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION },
        provenance:{ kind:'project_transition_settlement', lease_ref:'11111111-1111-4111-8111-111111111111', run_id:'bootstrap-run', settled_at:'2026-08-28T20:00:00.000Z' },
      }],
    });
    const graph = await reader({ project_ref:'github:laurajoyhutchins/overcenter' });
    const evaluated = evaluateProjectGraph(graph);
    assert(evaluated.nodes.find((node)=>node.id === 'first')?.state === 'DONE', 'compatible confirmation did not mark predecessor DONE');
    assert(evaluated.nodes.find((node)=>node.id === 'second')?.state === 'READY', 'confirmed predecessor did not unblock successor');
  });

  await test('materially different transition fingerprint cannot inherit prior confirmation', async()=>{
    const fixture = definitionFacts();
    const reader = createAuthoritativeProjectGraphReader({
      resolveProjectAuthority:async()=>({ kind:'github', repository:fixture.repository, revision:fixture.revision, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION }),
      readProjectFacts:async()=>({ schema:'project-authority-facts-v1', repository:fixture.repository, revision:fixture.revision, facts:{ definition_facts:fixture.facts } }),
      readProjectObservations:async()=>[{
        schema:'project-transition-observation-v1',
        kind:'project_transition_confirmation',
        project_ref:'github:laurajoyhutchins/overcenter',
        transition_id:'first',
        transition_definition_fingerprint:'f'.repeat(64),
        disposition:'completed',
        authority:{ kind:'github', repository:fixture.repository, revision:'9'.repeat(40), derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION },
        provenance:{ kind:'project_transition_settlement', lease_ref:'22222222-2222-4222-8222-222222222222', run_id:'old-run', settled_at:'2026-08-28T19:00:00.000Z' },
      }],
    });
    const graph = await reader({ project_ref:'github:laurajoyhutchins/overcenter' });
    const evaluated = evaluateProjectGraph(graph);
    assert(evaluated.nodes.find((node)=>node.id === 'first')?.state === 'READY', 'mismatched fingerprint inherited completion');
    assert(evaluated.nodes.find((node)=>node.id === 'second')?.state === 'WAITING', 'successor escaped dependency after incompatible observation');
  });

  await test('production observation adapter projects completed project-transition settlement receipts', async()=>{
    const fixture = definitionFacts();
    const derived = deriveOvercenterProjectGraph({
      project_ref:'github:laurajoyhutchins/overcenter',
      authority:{ kind:'github', repository:fixture.repository, revision:fixture.revision, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION },
      facts:{ definition_facts:fixture.facts },
    });
    const fingerprint = await transitionFingerprint(derived.nodes.find((node)=>node.id === 'first'));
    const db = { async query() { return { rows:[{
      lease_ref:'33333333-3333-4333-8333-333333333333',
      run_id:'run-1',
      settled_at:'2026-08-28T20:00:00.000Z',
      settle_receipt:{
        schema:'project-transition-lease-settlement-v1', subject:'project_transition', disposition:'completed',
        project_transition:{ project_ref:'github:laurajoyhutchins/overcenter', transition_id:'first', repository:fixture.repository, authority_revision:'9'.repeat(40), authority_derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION, transition_definition_fingerprint:fingerprint },
      },
    }] }; } };
    const runtime = createGitHubProjectGraphRuntime({ withGitHubAppApiClient:async()=>{}, readProjectDefinitionFactsWithGitHubApp:async()=>{}, db });
    const observations = await runtime.readProjectObservations({ project_ref:'github:laurajoyhutchins/overcenter', repository:fixture.repository, revision:fixture.revision, derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION, nodes:derived.nodes });
    assert(observations.length === 1, 'completed project-transition settlement was not projected');
    assert(observations[0].transition_definition_fingerprint === fingerprint, 'observation lost transition-definition fingerprint');
  });

  await test('project-transition durable claim receipt preserves transition-definition fingerprint', async()=>{
    const fingerprint = 'e'.repeat(64);
    const prepared = await prepareProjectTransitionLeasePersistence({
      lease_id:'44444444-4444-4444-8444-444444444444',
      slot_key:'project_transition:github:laurajoyhutchins/overcenter:'+ 'a'.repeat(40)+':first',
      run_id:'run-1',
      project_ref:'github:laurajoyhutchins/overcenter',
      transition_id:'first',
      repository:'laurajoyhutchins/overcenter',
      authority_revision:'a'.repeat(40),
      authority_derivation:OVERCENTER_PROJECT_GRAPH_DERIVATION,
      transition_definition_fingerprint:fingerprint,
      acquired_at:'2026-08-28T20:00:00.000Z',
      expires_at:'2026-08-28T21:00:00.000Z',
    });
    assert(prepared.claim_receipt.project_transition.transition_definition_fingerprint === fingerprint, 'claim receipt dropped transition-definition fingerprint');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}