import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';
// command-response is inspected as source below to keep this host-neutral suite loadable.
import { createProjectAuthoringWorkerBinding } from '../lib/project-authoring-host-runtime.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('worker binding preserves explicit injection and otherwise composes bounded host capabilities', () => {
  const injected = { define() {}, amend() {} };
  const binding = createProjectAuthoringWorkerBinding({
    createGraphRuntime:({ db }) => ({ marker:db.marker }),
    readRepositoryDisposition:async (repository, { db }) => ({ repository, disposition:db.disposition }),
    applyGithubChangeset:async () => ({ ok:true, new_head:'b'.repeat(40) }),
    deriveProjectGraph:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }),
  });

  assert.equal(binding({ projectAuthoring:injected }), injected);
  const composed = binding({ db:{ marker:'host-db', disposition:'ACTIVE' } });
  assert.equal(typeof composed.define, 'function');
  assert.equal(typeof composed.amend, 'function');
});

test('default worker API consumes shared Overcenter host composition while semantic transport remains host-neutral', async () => {
  const [apiSource, hostSource, transportSource] = await Promise.all([
    readFile(new URL('../api/worker-command.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/project-authoring-overcenter-host.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8'),
  ]);
  assert.match(apiSource, /projectAuthoringFor.*project-authoring-overcenter-host\.js/);
  assert.match(apiSource, /createWorkerCommandHandler/);
  assert.doesNotMatch(apiSource, /createGitHubProjectGraphRuntime|createPostgresRepositoryDispositionStore|applyGithubChangesetRoleAware|deriveOvercenterProjectGraph/);
  assert.match(hostSource, /createProjectAuthoringWorkerBinding/);
  assert.match(hostSource, /createGitHubProjectGraphRuntime/);
  assert.match(hostSource, /createPostgresRepositoryDispositionStore/);
  assert.match(hostSource, /applyGithubChangesetRoleAware/);
  assert.match(hostSource, /deriveOvercenterProjectGraph/);
  assert.doesNotMatch(transportSource, /createPostgresRepositoryDispositionStore|applyGithubChangesetRoleAware|deriveOvercenterProjectGraph/);
});

test('project authoring commands are admitted by the canonical command envelope before worker execution', () => {
  assert.equal(CANONICAL_COMMANDS.includes('project.define'), true);
  assert.equal(CANONICAL_COMMANDS.includes('project.amend'), true);
});

test('host-neutral worker handler composes project authoring without caller-supplied runtime state', async () => {
  const workerHandler = await import('../lib/worker-command-handler.js');
  assert.equal(typeof workerHandler.createWorkerCommandHandler, 'function');

  let composedRuntime = null;
  let observed = null;
  const handler = workerHandler.createWorkerCommandHandler({
    db:{ marker:'worker-host-db' },
    commandFailure:() => ({ status:400, body:{ ok:false } }),
    projectAuthoringFor(runtime) {
      composedRuntime = runtime;
      return { define:async () => ({ ok:true }), amend:async () => ({ ok:true }) };
    },
    async executeSemanticWorkerCommand(command, input, runtime) {
      observed = { command, input, runtime };
      return { status:200, body:{ ok:true, command } };
    },
    logger:{ warn() {} },
  });
  const response = {
    statusCode:null,
    body:null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };

  await handler({ body:{ command:'project.amend', input:{
    project_ref:'github:example/project',
    expected_revision:initialRevision,
    amendment:{ remove_transitions:[] },
  } } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(composedRuntime.db.marker, 'worker-host-db');
  assert.equal(observed.command, 'project.amend');
  assert.equal(observed.runtime.projectAuthoring.define instanceof Function, true);
  assert.equal(Object.hasOwn(observed.input, 'runtime'), false);
  assert.equal(Object.hasOwn(observed.input, 'lease_ref'), false);
});

test('ordinary non-authoring worker commands do not require project-authoring host composition', async () => {
  const { createWorkerCommandHandler } = await import('../lib/worker-command-handler.js');
  let authoringCompositions = 0;
  let observedRuntime = null;
  const handler = createWorkerCommandHandler({
    db:{ marker:'worker-host-db' },
    commandFailure:() => ({ status:400, body:{ ok:false } }),
    projectAuthoringFor() {
      authoringCompositions += 1;
      throw new Error('project authoring should be lazy for unrelated commands');
    },
    async executeSemanticWorkerCommand(command, input, runtime) {
      observedRuntime = runtime;
      return { status:200, body:{ ok:true, command, input } };
    },
    logger:{ warn() {} },
  });
  const response = {
    statusCode:null,
    body:null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return body; },
  };

  await handler({ body:{ command:'work.claim', input:{ work_ref:'LJH-1' } } }, response);

  assert.equal(response.statusCode, 200);
  assert.equal(authoringCompositions, 0);
  assert.equal(observedRuntime.db.marker, 'worker-host-db');
  assert.equal(Object.hasOwn(observedRuntime, 'projectAuthoring'), false);
});

test('stale project-definition authority is registered as a worker precondition rejection without coupling the neutral handler to command-response runtime imports', async () => {
  const source = await readFile(new URL('../lib/command-response.js', import.meta.url), 'utf8');
  const marker = "] ,'precondition'";
  const canonicalMarker = "], 'precondition', false, DEFAULT_STATUS.precondition, true);";
  const end = source.indexOf(canonicalMarker);
  assert.notEqual(end, -1);
  const start = source.lastIndexOf('register([', end);
  assert.notEqual(start, -1);
  const preconditionBlock = source.slice(start, end);
  assert.match(preconditionBlock, /'PROJECT_DEFINITION_MUTATION_AUTHORITY_STALE'/);
  assert.match(preconditionBlock, /'PROJECT_AUTHORING_AUTHORITY_STALE'/);
});

test('durable orchestration journal projects bounded project authoring source coordinates', async () => {
  const journalSource = await readFile(new URL('../lib/orchestration-journal.js', import.meta.url), 'utf8');
  assert.match(journalSource, /command === 'project\.define'/);
  assert.match(journalSource, /command === 'project\.amend'/);
  assert.match(journalSource, /project_ref/);
  assert.match(journalSource, /expected_revision/);
  assert.match(journalSource, /transition_count|add_transition_count|remove_transition_count/);
});

test('GitHub graph authority preserves missing host credentials instead of laundering them as a generic graph read failure', async () => {
  const source = await readFile(new URL('../lib/project-graph-github-runtime.js', import.meta.url), 'utf8');
  assert.match(source, /catch \(error\) \{\s*if \(error\?\.code === 'GITHUB_APP_SETUP_REQUIRED'\) throw error;/);
});

test('GitHub graph authority normalizes host configuration setup failures before they cross the semantic worker boundary', async () => {
  const source = await readFile(new URL('../lib/project-graph-github-runtime.js', import.meta.url), 'utf8');
  assert.match(source, /config\\\/get 412\|declared as required but not set/i);
  assert.match(source, /GITHUB_APP_SETUP_REQUIRED/);
});
