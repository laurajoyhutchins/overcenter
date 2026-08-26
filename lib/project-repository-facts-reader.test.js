import { runProjectObservationReaderTests } from './project-observation-reader.test.js';
import { createProjectRepositoryFactsReader, readProjectRepositoryFactsWithGitHubApp } from './project-repository-facts-reader.js';

function assert(value, message) { if (!value) throw new Error(message); }

const REVISION = '1234567890abcdef1234567890abcdef12345678';
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';

function apiFixture(overrides = {}) {
  const calls = [];
  const responses = {
    '/repos/laurajoyhutchins/overcenter': { status:200, body:{ default_branch:'main' } },
    [`/repos/laurajoyhutchins/overcenter/commits/${REVISION}`]: { status:200, body:{ sha:REVISION } },
    '/repos/laurajoyhutchins/overcenter/pulls': { status:200, body:[{
      number:48,
      state:'open',
      draft:true,
      mergeable:true,
      head:{ sha:HEAD },
      base:{ sha:REVISION },
    }] },
    [`/repos/laurajoyhutchins/overcenter/commits/${HEAD}/check-runs`]: { status:200, body:{ total_count:1, check_runs:[{
      name:'repository-static',
      status:'completed',
      conclusion:'failure',
    }] } },
    ...overrides,
  };
  return {
    calls,
    client:{
      async call(name, input) {
        assert(name === 'github', 'non-GitHub API requested');
        calls.push(input);
        const response = responses[input.path];
        if (!response) throw new Error(`unexpected path ${input.path}`);
        return response;
      },
    },
  };
}

export async function runProjectRepositoryFactsReaderTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('reads exact repository, open PR, and check facts into the authority envelope', async()=>{
    const fixture = apiFixture();
    const readProjectFacts = createProjectRepositoryFactsReader(fixture.client);
    const result = await readProjectFacts({ repository:'laurajoyhutchins/overcenter', revision:REVISION });
    assert(result.schema === 'project-authority-facts-v1', 'authority envelope schema mismatch');
    assert(result.repository === 'laurajoyhutchins/overcenter', 'repository mismatch');
    assert(result.revision === REVISION, 'revision mismatch');
    assert(result.facts.schema === 'project-repository-facts-v1', 'facts schema mismatch');
    assert(result.facts.default_branch === 'main', 'default branch mismatch');
    assert(result.facts.pull_requests.length === 1, 'pull request missing');
    assert(result.facts.pull_requests[0].number === 48, 'pull request identity mismatch');
    assert(result.facts.pull_requests[0].checks[0].name === 'repository-static', 'check evidence missing');
    assert(fixture.calls.some((call)=>call.path.endsWith(`/commits/${REVISION}`)), 'exact revision was not verified');
  });

  await test('binds the reader to the narrow GitHub App project_facts capability', async()=>{
    const fixture = apiFixture();
    const bindings = [];
    const result = await readProjectRepositoryFactsWithGitHubApp({
      repository:'laurajoyhutchins/overcenter',
      revision:REVISION,
    }, {
      withGitHubAppApiClient:async (repository, callback, options) => {
        bindings.push({ repository, options });
        return callback(fixture.client);
      },
    });
    assert(result.schema === 'project-authority-facts-v1', 'bound authority envelope schema mismatch');
    assert(JSON.stringify(bindings) === JSON.stringify([{
      repository:'laurajoyhutchins/overcenter',
      options:{ permissionProfile:'project_facts' },
    }]), 'project facts reader did not request the exact command-owned capability');
  });

  await test('fails closed when GitHub cannot attribute the requested exact revision', async()=>{
    const fixture = apiFixture({
      [`/repos/laurajoyhutchins/overcenter/commits/${REVISION}`]: { status:200, body:{ sha:HEAD } },
    });
    const readProjectFacts = createProjectRepositoryFactsReader(fixture.client);
    let failed = false;
    try { await readProjectFacts({ repository:'laurajoyhutchins/overcenter', revision:REVISION }); }
    catch (error) { failed = error?.code === 'PROJECT_REPOSITORY_FACTS_READ_FAILED'; }
    assert(failed, 'revision attribution mismatch did not fail closed');
  });

  await test('fails closed instead of silently truncating pull-request facts', async()=>{
    const hundred = Array.from({ length:100 }, (_, index)=>({
      number:index + 1,
      state:'open',
      draft:false,
      mergeable:true,
      head:{ sha:HEAD },
      base:{ sha:REVISION },
    }));
    const fixture = apiFixture({ '/repos/laurajoyhutchins/overcenter/pulls': { status:200, body:hundred } });
    const readProjectFacts = createProjectRepositoryFactsReader(fixture.client);
    let failed = false;
    try { await readProjectFacts({ repository:'laurajoyhutchins/overcenter', revision:REVISION }); }
    catch (error) { failed = error?.code === 'PROJECT_REPOSITORY_FACTS_INCOMPLETE'; }
    assert(failed, 'possibly truncated PR inventory was accepted');
  });

  const observationResult = await runProjectObservationReaderTests();
  for (const entry of observationResult.tests) tests.push({ ...entry, name:`observations: ${entry.name}` });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
