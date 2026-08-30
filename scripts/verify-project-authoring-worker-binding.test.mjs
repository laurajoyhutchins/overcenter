import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('default worker API composes project authoring while semantic transport remains host-neutral', async () => {
  const [apiSource, transportSource] = await Promise.all([
    readFile(new URL('../api/worker-command.js', import.meta.url), 'utf8'),
    readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8'),
  ]);
  assert.match(apiSource, /createProjectAuthoringWorkerBinding/);
  assert.match(apiSource, /createWorkerCommandHandler/);
  assert.match(apiSource, /createGitHubProjectGraphRuntime/);
  assert.match(apiSource, /createPostgresRepositoryDispositionStore/);
  assert.match(apiSource, /applyGithubChangesetRoleAware/);
  assert.match(apiSource, /deriveOvercenterProjectGraph/);
  assert.doesNotMatch(transportSource, /createPostgresRepositoryDispositionStore|applyGithubChangesetRoleAware|deriveOvercenterProjectGraph/);
});

test('host-neutral worker handler composes project authoring without caller-supplied runtime state', async () => {
  const workerHandler = await import('../lib/worker-command-handler.js');
  assert.equal(typeof workerHandler.createWorkerCommandHandler, 'function');

  let composedRuntime = null;
  let observed = null;
  const handler = workerHandler.createWorkerCommandHandler({
    db:{ marker:'worker-host-db' },
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