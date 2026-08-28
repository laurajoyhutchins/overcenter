import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizeProjectRepositoryFacts } from './project-repository-facts.js';

function assert(value, message) { if (!value) throw new Error(message); }
function expectFailure(fn, message) {
  let failed = false;
  try { fn(); } catch { failed = true; }
  assert(failed, message);
}

const REVISION = '1234567890abcdef1234567890abcdef12345678';
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';

function candidate(overrides = {}) {
  return {
    schema:'project-repository-facts-v1',
    repository:'laurajoyhutchins/overcenter',
    revision:REVISION,
    default_branch:'main',
    pull_requests:[{
      number:41,
      state:'open',
      draft:true,
      mergeable:true,
      head_sha:HEAD,
      base_sha:REVISION,
      checks:[
        { name:'repository-static', status:'completed', conclusion:'failure' },
        { name:'another-check', status:'queued', conclusion:null },
      ],
    }],
    ...overrides,
  };
}

function walk(value, visit) {
  visit(value);
  if (Array.isArray(value)) value.forEach((entry)=>walk(entry, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry)=>walk(entry, visit));
}

export async function runProjectRepositoryFactsTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok:true }); }
    catch (error) { tests.push({ name, ok:false, error:String(error?.message || error) }); }
  }

  await test('normalizes exact revision-attributed repository and pull-request facts', async()=>{
    const result = normalizeProjectRepositoryFacts(candidate());
    assert(result.schema === 'project-repository-facts-v1', 'schema mismatch');
    assert(result.repository === 'laurajoyhutchins/overcenter', 'repository mismatch');
    assert(result.revision === REVISION, 'revision mismatch');
    assert(result.pull_requests.length === 1, 'pull request count mismatch');
    assert(result.pull_requests[0].head_sha === HEAD, 'head attribution mismatch');
    assert(result.pull_requests[0].checks[0].name === 'another-check', 'checks were not normalized deterministically');
  });

  await test('rejects ambiguous or inexact repository authority', async()=>{
    expectFailure(()=>normalizeProjectRepositoryFacts(candidate({ repository:'overcenter' })), 'implicit repository accepted');
    expectFailure(()=>normalizeProjectRepositoryFacts(candidate({ revision:'main' })), 'symbolic revision accepted');
  });

  await test('rejects unsupported facts instead of silently extending graph authority', async()=>{
    expectFailure(()=>normalizeProjectRepositoryFacts({ ...candidate(), issues:[] }), 'unsupported issue facts accepted');
    expectFailure(()=>normalizeProjectRepositoryFacts(candidate({ schema:'project-repository-facts-v2' })), 'unsupported schema accepted');
  });

  await test('rejects duplicate pull-request identities', async()=>{
    const value = candidate();
    value.pull_requests = [value.pull_requests[0], { ...value.pull_requests[0] }];
    expectFailure(()=>normalizeProjectRepositoryFacts(value), 'duplicate pull request number accepted');
  });

  await test('rejects malformed check state and conclusion attribution', async()=>{
    const badStatus = candidate();
    badStatus.pull_requests[0].checks = [{ name:'x', status:'waiting', conclusion:null }];
    expectFailure(()=>normalizeProjectRepositoryFacts(badStatus), 'unsupported check status accepted');

    const earlyConclusion = candidate();
    earlyConclusion.pull_requests[0].checks = [{ name:'x', status:'queued', conclusion:'success' }];
    expectFailure(()=>normalizeProjectRepositoryFacts(earlyConclusion), 'conclusion accepted before completion');
  });

  await test('project definition discovery is bounded repository-owned structure', async()=>{
    const {
      PROJECT_DEFINITION_DISCOVERY_PATH,
      normalizeProjectDefinitionDiscovery,
      parseProjectDefinitionDiscovery,
    } = await import('./project-definition-discovery.js');
    assert(PROJECT_DEFINITION_DISCOVERY_PATH === '.overcenter/project-definitions.json', 'definition discovery coordinate changed');
    const normalized = normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:['docs/z.md','docs/a.md'] });
    assert(normalized.definitions.join(',') === 'docs/a.md,docs/z.md', 'definition discovery is not deterministic');
    assert(parseProjectDefinitionDiscovery(JSON.stringify(normalized)).definitions.length === 2, 'definition discovery JSON did not round-trip');
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:['docs/a.md'], nodes:[] }), 'runtime graph state entered discovery facts');
    expectFailure(()=>normalizeProjectDefinitionDiscovery({ schema:'project-definition-discovery-v1', definitions:['../x.md'] }), 'unsafe definition path accepted');
  });

  await test('project definition facts preserve exact source identity without derived graph state', async()=>{
    const { normalizeProjectDefinitionFacts, PROJECT_DEFINITION_FACTS_SCHEMA } = await import('./project-definition-facts.js');
    const facts = normalizeProjectDefinitionFacts({
      schema:PROJECT_DEFINITION_FACTS_SCHEMA,
      repository:'laurajoyhutchins/overcenter',
      revision:REVISION,
      definitions:[{
        path:'docs/project.md',
        blob_sha:'1'.repeat(40),
        sha256:'a'.repeat(64),
        media_type:'text/plain',
        content:'# Project\n',
      }],
    });
    assert(facts.repository === 'laurajoyhutchins/overcenter' && facts.revision === REVISION, 'definition fact authority changed');
    assert(Object.isFrozen(facts) && Object.isFrozen(facts.definitions), 'definition facts are mutable');
    expectFailure(()=>normalizeProjectDefinitionFacts({ ...facts, nodes:[] }), 'derived graph state entered definition facts');
  });

  await test('project definition reader binds every content read to the exact revision', async()=>{
    const { createProjectDefinitionFactsReader, readProjectDefinitionFactsWithGitHubApp } = await import('./project-definition-facts-reader.js');
    const calls = [];
    const discovery = JSON.stringify({ schema:'project-definition-discovery-v1', definitions:['docs/project.md'] });
    const file = (sha, content) => {
      const bytes = Buffer.from(content, 'utf8');
      return { status:200, body:{ type:'file', sha, encoding:'base64', content:bytes.toString('base64'), size:bytes.length } };
    };
    const responses = {
      [`/repos/laurajoyhutchins/overcenter/commits/${REVISION}`]: { status:200, body:{ sha:REVISION } },
      '/repos/laurajoyhutchins/overcenter/contents/.overcenter/project-definitions.json': file('1'.repeat(40), discovery),
      '/repos/laurajoyhutchins/overcenter/contents/docs/project.md': file('2'.repeat(40), '# Project\n'),
    };
    const client = { async call(name, input) {
      assert(name === 'github', 'reader escaped GitHub authority');
      calls.push(input);
      const response = responses[input.path];
      if (!response) throw new Error(`unexpected path ${input.path}`);
      return response;
    } };
    const facts = await createProjectDefinitionFactsReader(client)({ repository:'laurajoyhutchins/overcenter', revision:REVISION });
    assert(facts.definitions[0].sha256 === createHash('sha256').update('# Project\n').digest('hex'), 'definition content digest mismatch');
    assert(calls.filter((call)=>call.path.includes('/contents/')).every((call)=>call.query?.ref === REVISION), 'definition content read escaped exact revision');

    const bindings = [];
    await readProjectDefinitionFactsWithGitHubApp({ repository:'laurajoyhutchins/overcenter', revision:REVISION }, {
      withGitHubAppApiClient:async (repository, callback, options) => {
        bindings.push({ repository, options });
        return callback(client);
      },
    });
    assert(JSON.stringify(bindings) === JSON.stringify([{
      repository:'laurajoyhutchins/overcenter',
      options:{ permissionProfile:'project_facts' },
    }]), 'definition reader did not request project_facts capability');
  });

  await test('checked-in Overcenter definition source contains structure but no runtime lifecycle truth', async()=>{
    const discovery = JSON.parse(await readFile('.overcenter/project-definitions.json', 'utf8'));
    assert(discovery.schema === 'project-definition-discovery-v1', 'checked-in discovery schema mismatch');
    assert(JSON.stringify(discovery.definitions) === JSON.stringify(['.overcenter/definitions/target-architecture.json']), 'checked-in definition set is not narrow');
    const definition = JSON.parse(await readFile(discovery.definitions[0], 'utf8'));
    assert(definition.schema === 'overcenter-project-definition-v1', 'checked-in project definition schema mismatch');
    assert(definition.project_ref === 'github:laurajoyhutchins/overcenter', 'checked-in project identity mismatch');
    assert(Array.isArray(definition.transitions) && definition.transitions.length > 0, 'checked-in project definition has no transitions');
    const ids = new Set(definition.transitions.map((entry)=>entry.id));
    assert(ids.size === definition.transitions.length, 'transition identities are not unique');
    for (const transition of definition.transitions) {
      assert(typeof transition.id === 'string' && transition.id.length > 0, 'transition identity missing');
      assert(Number.isInteger(transition.priority), `priority missing for ${transition.id}`);
      assert(Array.isArray(transition.requires), `dependencies missing for ${transition.id}`);
      assert(transition.requires.every((dependency)=>ids.has(dependency) && dependency !== transition.id), `invalid dependency for ${transition.id}`);
      assert(transition.executor?.kind === 'agent' || transition.executor?.kind === 'operator', `executor kind missing for ${transition.id}`);
      if (transition.executor?.kind === 'agent') assert(typeof transition.executor.skill === 'string' && transition.executor.skill.length > 0, `agent skill missing for ${transition.id}`);
    }
    const forbidden = new Set(['state','lane','lease','lease_id','ready','condition','checks','pull_requests','active_revision']);
    walk(definition, (value)=>{
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const key of Object.keys(value)) assert(!forbidden.has(key), `runtime field persisted in project definition: ${key}`);
    });
  });

  return { ok:tests.every((entry)=>entry.ok), passed:tests.filter((entry)=>entry.ok).length, failed:tests.filter((entry)=>!entry.ok).length, tests };
}
