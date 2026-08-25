import {
  PROJECT_GRAPH_DERIVATION_DECLARATION_PATH,
  normalizeProjectGraphDerivationDeclaration,
  parseProjectGraphDerivationDeclaration,
} from './project-graph-derivation-discovery.js';

function assert(value, message) { if (!value) throw new Error(message); }
function expectFailure(fn, message) {
  let failed = false;
  try { fn(); } catch { failed = true; }
  assert(failed, message);
}

export async function runProjectGraphDerivationDiscoveryTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('declaration path is fixed and repository-owned', async()=>{
    assert(PROJECT_GRAPH_DERIVATION_DECLARATION_PATH === '.busbar/project-graph.json', 'declaration path changed');
  });

  await test('declaration yields only one registered derivation identity', async()=>{
    const result = normalizeProjectGraphDerivationDeclaration({
      schema:'project-graph-derivation-v1',
      derivation:'busbar-project-graph-v1',
    });
    assert(result.schema === 'project-graph-derivation-v1', 'schema mismatch');
    assert(result.derivation === 'busbar-project-graph-v1', 'derivation mismatch');
    assert(Object.keys(result).length === 2, 'declaration retained unsupported authority state');
  });

  await test('JSON declaration parsing is deterministic', async()=>{
    const result = parseProjectGraphDerivationDeclaration('{"schema":"project-graph-derivation-v1","derivation":"busbar-project-graph-v1"}\n');
    assert(result.derivation === 'busbar-project-graph-v1', 'parsed derivation mismatch');
  });

  await test('declaration rejects graph state and authority coordinates', async()=>{
    expectFailure(()=>normalizeProjectGraphDerivationDeclaration({ schema:'project-graph-derivation-v1', derivation:'d', nodes:[] }), 'graph nodes were accepted');
    expectFailure(()=>normalizeProjectGraphDerivationDeclaration({ schema:'project-graph-derivation-v1', derivation:'d', repository:'laurajoyhutchins/busbar' }), 'repository authority was accepted');
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

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
