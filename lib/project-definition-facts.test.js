import { normalizeProjectDefinitionFacts, PROJECT_DEFINITION_FACTS_SCHEMA } from './project-definition-facts.js';

function assert(value, message) { if (!value) throw new Error(message); }
function expectFailure(fn, message) {
  let failed = false;
  try { fn(); } catch (error) { failed = error?.code === 'PROJECT_DEFINITION_FACTS_INVALID'; }
  assert(failed, message);
}

const REVISION = '1234567890abcdef1234567890abcdef12345678';
const BLOB_A = '1111111111111111111111111111111111111111';
const BLOB_B = '2222222222222222222222222222222222222222';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function definition(path, blob_sha, sha256, content) {
  return { path, blob_sha, sha256, media_type:'text/plain', content };
}

export async function runProjectDefinitionFactsTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('normalizes exact-revision repository definition facts deterministically', async()=>{
    const result = normalizeProjectDefinitionFacts({
      schema:PROJECT_DEFINITION_FACTS_SCHEMA,
      repository:'laurajoyhutchins/overcenter',
      revision:REVISION,
      definitions:[
        definition('package.json', BLOB_B, SHA_B, '{"name":"overcenter"}'),
        definition('.ci/contract.json', BLOB_A, SHA_A, '{"schema":"repository-ci-contract-v1"}'),
      ],
    });
    assert(result.revision === REVISION, 'revision changed');
    assert(result.definitions[0].path === '.ci/contract.json', 'definitions were not sorted by path');
    assert(Object.isFrozen(result) && Object.isFrozen(result.definitions), 'definition facts were not frozen');
  });

  await test('rejects non-exact revision and invalid repository coordinates', async()=>{
    expectFailure(()=>normalizeProjectDefinitionFacts({ schema:PROJECT_DEFINITION_FACTS_SCHEMA, repository:'overcenter', revision:'main', definitions:[definition('README.md', BLOB_A, SHA_A, 'x')] }), 'ambiguous authority was accepted');
  });

  await test('rejects duplicate or unsafe repository-relative paths', async()=>{
    expectFailure(()=>normalizeProjectDefinitionFacts({ schema:PROJECT_DEFINITION_FACTS_SCHEMA, repository:'laurajoyhutchins/overcenter', revision:REVISION, definitions:[definition('../README.md', BLOB_A, SHA_A, 'x')] }), 'unsafe path was accepted');
    expectFailure(()=>normalizeProjectDefinitionFacts({ schema:PROJECT_DEFINITION_FACTS_SCHEMA, repository:'laurajoyhutchins/overcenter', revision:REVISION, definitions:[definition('README.md', BLOB_A, SHA_A, 'x'), definition('README.md', BLOB_B, SHA_B, 'y')] }), 'duplicate paths were accepted');
  });

  await test('rejects incomplete content identity', async()=>{
    expectFailure(()=>normalizeProjectDefinitionFacts({ schema:PROJECT_DEFINITION_FACTS_SCHEMA, repository:'laurajoyhutchins/overcenter', revision:REVISION, definitions:[definition('README.md', 'bad', SHA_A, 'x')] }), 'invalid blob identity was accepted');
    expectFailure(()=>normalizeProjectDefinitionFacts({ schema:PROJECT_DEFINITION_FACTS_SCHEMA, repository:'laurajoyhutchins/overcenter', revision:REVISION, definitions:[definition('README.md', BLOB_A, 'bad', 'x')] }), 'invalid content digest was accepted');
  });

  await test('rejects caller extensions that could smuggle derived graph state', async()=>{
    const input = { schema:PROJECT_DEFINITION_FACTS_SCHEMA, repository:'laurajoyhutchins/overcenter', revision:REVISION, definitions:[definition('README.md', BLOB_A, SHA_A, 'x')], nodes:[] };
    expectFailure(()=>normalizeProjectDefinitionFacts(input), 'derived graph fields were accepted');
  });

  return tests;
}
