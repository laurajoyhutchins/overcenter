import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { OVERCENTER_PROJECT_DEFINITION_PATH } from './overcenter-project-graph-deriver.js';

function assert(value, message) { if (!value) throw new Error(message); }
const REPOSITORY = 'laurajoyhutchins/overcenter';
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const PROJECT_REF = `github:${REPOSITORY}`;
function definitions(revision = REVISION) {
  return { schema:'project-definition-facts-v1', repository:REPOSITORY, revision, definitions:[{ path:OVERCENTER_PROJECT_DEFINITION_PATH, blob_sha:'a'.repeat(40), sha256:'b'.repeat(64), media_type:'text/plain', content:JSON.stringify({ schema:'overcenter-project-definition-v1', project_ref:PROJECT_REF, transitions:[{ id:'register-project-graph-deriver', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] }) }] };
}
function runtime(readDefinitions) {
  return {
    resolveProjectAuthority:async () => ({ kind:'github', repository:REPOSITORY, revision:REVISION, derivation:'overcenter-project-graph-v1' }),
    readProjectFacts:async () => ({ schema:'project-authority-facts-v1', repository:REPOSITORY, revision:REVISION, facts:{ schema:'project-repository-facts-v1', repository:REPOSITORY, revision:REVISION, default_branch:'dev', pull_requests:[] } }),
    readProjectDefinitionFacts:readDefinitions,
    readProjectObservations:async () => [],
  };
}

export async function runProjectGraphAuthorityTests() {
  const tests = [];
  async function test(name, fn) { try { await fn(); tests.push({ name, ok:true }); } catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); } }

  await test('default registry derives Overcenter from exact definition facts', async()=>{
    const calls = [];
    const read = createAuthoritativeProjectGraphReader(runtime(async (input) => { calls.push(input); return definitions(); }));
    const graph = await read({ project_ref:PROJECT_REF });
    assert(graph.nodes.length === 1 && graph.nodes[0].id === 'register-project-graph-deriver', 'default deriver did not produce node');
    assert(calls.length === 1 && calls[0].revision === REVISION, 'definitions were not read at exact authority revision');
  });

  await test('stale definition facts fail closed before derivation', async()=>{
    const read = createAuthoritativeProjectGraphReader(runtime(async () => definitions('0'.repeat(40))));
    let code = null;
    try { await read({ project_ref:PROJECT_REF }); } catch (error) { code = error?.code || null; }
    assert(code === 'PROJECT_GRAPH_DEFINITION_FACTS_MISMATCH', 'stale definition facts were accepted');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
