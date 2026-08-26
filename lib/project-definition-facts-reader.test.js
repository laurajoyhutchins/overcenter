import { createHash } from 'node:crypto';
import {
  createProjectDefinitionFactsReader,
  readProjectDefinitionFactsWithGitHubApp,
} from './project-definition-facts-reader.js';

function assert(value, message) { if (!value) throw new Error(message); }
const REVISION = '1234567890abcdef1234567890abcdef12345678';
const DISCOVERY_SHA = '1'.repeat(40);
const DEFINITION_SHA = '2'.repeat(40);

function file(sha, content, overrides = {}) {
  const bytes = Buffer.from(content, 'utf8');
  return { status:200, body:{ type:'file', sha, encoding:'base64', content:bytes.toString('base64'), size:bytes.length, ...overrides } };
}

function fixture(overrides = {}) {
  const calls = [];
  const discovery = JSON.stringify({ schema:'project-definition-discovery-v1', definitions:['docs/project.md'] });
  const responses = {
    [`/repos/laurajoyhutchins/overcenter/commits/${REVISION}`]: { status:200, body:{ sha:REVISION } },
    '/repos/laurajoyhutchins/overcenter/contents/.overcenter/project-definitions.json': file(DISCOVERY_SHA, discovery),
    '/repos/laurajoyhutchins/overcenter/contents/docs/project.md': file(DEFINITION_SHA, '# Project\n'),
    ...overrides,
  };
  return {
    calls,
    client:{ async call(name, input) {
      assert(name === 'github', 'non-GitHub API requested');
      calls.push(input);
      const response = responses[input.path];
      if (!response) throw new Error(`unexpected path ${input.path}`);
      return response;
    } },
  };
}

export async function runProjectDefinitionFactsReaderTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('reads repository-owned definitions at the requested exact revision', async()=>{
    const f = fixture();
    const result = await createProjectDefinitionFactsReader(f.client)({ repository:'laurajoyhutchins/overcenter', revision:REVISION });
    assert(result.schema === 'project-definition-facts-v1', 'facts schema mismatch');
    assert(result.revision === REVISION, 'revision mismatch');
    assert(result.definitions.length === 1, 'definition missing');
    assert(result.definitions[0].path === 'docs/project.md', 'definition path mismatch');
    assert(result.definitions[0].blob_sha === DEFINITION_SHA, 'blob identity missing');
    assert(result.definitions[0].sha256 === createHash('sha256').update('# Project\n').digest('hex'), 'content digest mismatch');
    const contentCalls = f.calls.filter((call)=>call.path.includes('/contents/'));
    assert(contentCalls.every((call)=>call.query?.ref === REVISION), 'definition content was not bound to the exact revision');
  });

  await test('binds reads to the narrow project_facts GitHub App capability', async()=>{
    const f = fixture();
    const bindings = [];
    await readProjectDefinitionFactsWithGitHubApp({ repository:'laurajoyhutchins/overcenter', revision:REVISION }, {
      withGitHubAppApiClient:async (repository, callback, options) => {
        bindings.push({ repository, options });
        return callback(f.client);
      },
    });
    assert(JSON.stringify(bindings) === JSON.stringify([{
      repository:'laurajoyhutchins/overcenter',
      options:{ permissionProfile:'project_facts' },
    }]), 'definition reader did not request project_facts capability');
  });

  await test('fails closed when exact revision attribution is ambiguous', async()=>{
    const f = fixture({ [`/repos/laurajoyhutchins/overcenter/commits/${REVISION}`]: { status:200, body:{ sha:'3'.repeat(40) } } });
    let failed = false;
    try { await createProjectDefinitionFactsReader(f.client)({ repository:'laurajoyhutchins/overcenter', revision:REVISION }); }
    catch (error) { failed = error?.code === 'PROJECT_DEFINITION_FACTS_READ_FAILED'; }
    assert(failed, 'ambiguous revision attribution was accepted');
  });

  await test('fails closed on truncated or size-mismatched repository content', async()=>{
    const discovery = JSON.stringify({ schema:'project-definition-discovery-v1', definitions:['docs/project.md'] });
    const truncated = fixture({
      '/repos/laurajoyhutchins/overcenter/contents/.overcenter/project-definitions.json': file(DISCOVERY_SHA, discovery, { truncated:true }),
    });
    let truncatedFailed = false;
    try { await createProjectDefinitionFactsReader(truncated.client)({ repository:'laurajoyhutchins/overcenter', revision:REVISION }); }
    catch (error) { truncatedFailed = error?.code === 'PROJECT_DEFINITION_FACTS_INCOMPLETE'; }
    assert(truncatedFailed, 'truncated discovery content was accepted');

    const mismatched = fixture({
      '/repos/laurajoyhutchins/overcenter/contents/docs/project.md': file(DEFINITION_SHA, '# Project\n', { size:999 }),
    });
    let sizeFailed = false;
    try { await createProjectDefinitionFactsReader(mismatched.client)({ repository:'laurajoyhutchins/overcenter', revision:REVISION }); }
    catch (error) { sizeFailed = error?.code === 'PROJECT_DEFINITION_FACTS_INCOMPLETE'; }
    assert(sizeFailed, 'size-mismatched definition content was accepted');
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
