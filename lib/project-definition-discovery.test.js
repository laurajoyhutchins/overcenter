import {
  PROJECT_DEFINITION_DISCOVERY_PATH,
  normalizeProjectDefinitionDiscovery,
  parseProjectDefinitionDiscovery,
} from './project-definition-discovery.js';

function assert(value, message) { if (!value) throw new Error(message); }
function expectFailure(fn, message) {
  let failed = false;
  try { fn(); } catch { failed = true; }
  assert(failed, message);
}

export async function runProjectDefinitionDiscoveryTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('discovery coordinate is fixed and repository-owned', async()=>{
    assert(PROJECT_DEFINITION_DISCOVERY_PATH === '.overcenter/project-definitions.json', 'discovery path changed');
  });

  await test('declaration yields a deterministic bounded definition set', async()=>{
    const result = normalizeProjectDefinitionDiscovery({
      schema:'project-definition-discovery-v1',
      definitions:['docs/z.md','docs/a.md'],
    });
    assert(result.schema === 'project-definition-discovery-v1', 'schema mismatch');
    assert(result.definitions.join(',') === 'docs/a.md,docs/z.md', 'definitions not normalized deterministically');
    assert(Object.keys(result).length === 2, 'unsupported state retained');
  });

  await test('JSON parsing preserves the declaration contract', async()=>{
    const result = parseProjectDefinitionDiscovery('{"schema":"project-definition-discovery-v1","definitions":["docs/project.md"]}\n');
    assert(result.definitions[0] === 'docs/project.md', 'parsed definition mismatch');
  });

  await test('declaration rejects caller graph state and authority coordinates', async()=>{
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:['docs/a.md'], nodes:[] }), 'graph state accepted');
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:['docs/a.md'], repository:'owner/repo' }), 'repository authority accepted');
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:['docs/a.md'], revision:'0'.repeat(40) }), 'revision authority accepted');
  });

  await test('declaration rejects unsafe duplicate and self-selecting paths', async()=>{
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:['../x.md'] }), 'unsafe path accepted');
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:['docs/a.md','docs/a.md'] }), 'duplicate path accepted');
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:[PROJECT_DEFINITION_DISCOVERY_PATH] }), 'self-selection accepted');
  });

  await test('declaration rejects malformed shape and unsupported schema', async()=>{
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v2', definitions:['docs/a.md'] }), 'unsupported schema accepted');
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:[] }), 'empty definitions accepted');
    expectFailure(()=>parseProjectDefinitionDiscovery('{'), 'malformed JSON accepted');
    expectFailure(()=>parseProjectDefinitionDiscovery('[]'), 'array declaration accepted');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
