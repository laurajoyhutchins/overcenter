import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectAuthoringGithubAdapter,
  projectAuthoringIdempotencyKey,
} from '../lib/project-authoring-github-runtime.js';
import { normalizeProjectDefinitionFacts } from '../lib/project-definition-facts.js';
import { createProjectDefinitionFactsReader } from '../lib/project-definition-facts-reader.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const stagedRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const authoritativeRevision = 'cccccccccccccccccccccccccccccccccccccccc';
const projectRef = 'github:example/project';
const baseDefinition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};

function facts(revision, definition = baseDefinition) {
  return {
    schema:'project-definition-facts-v1',
    repository:'example/project',
    revision,
    definitions:[
      { path:'.overcenter/definitions/unrelated.json', content:JSON.stringify({ note:'not a project definition' }) },
      { path:'.overcenter/definitions/project.json', content:JSON.stringify(definition) },
    ],
  };
}

test('GitHub-backed authoring fences mutation then confirms the intended definition through refreshed authority', async () => {
  const calls = [];
  let authorityReads = 0;
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority:async () => ({ project_ref:projectRef, kind:'github', repository:'example/project', revision:++authorityReads === 1 ? initialRevision : authoritativeRevision, derivation:'overcenter-project-graph-v1' }),
    readDefinitionFacts:async ({ repository, revision }) => {
      calls.push(['read', repository, revision]);
      const definition = revision === authoritativeRevision
        ? { ...baseDefinition, transitions:[...baseDefinition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] }
        : baseDefinition;
      return facts(revision, definition);
    },
    applyChangeset:async (request) => {
      calls.push(['mutate', request.repo, request.base_sha, request.expected_head, request.changes[0].path, request.idempotency_key]);
      assert.match(request.branch, /^chore\/project-authoring-amend-[0-9a-f]{24}$/);
      assert.equal(request.changes[0].content.endsWith('\n'), true);
      assert.deepEqual(JSON.parse(request.changes[0].content).transitions.map((item) => item.id), ['foundation', 'second']);
      return { ok:true, new_head:stagedRevision };
    },
    deriveProjectGraph:async ({ authority, facts:inputFacts }) => {
      calls.push(['derive', authority.revision, inputFacts.definition_facts.revision]);
      return { schema:'overcenter-project-graph-v1', revision:authority.revision };
    },
  });

  const result = await adapter.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    lease_ref:'lease-ref',
    run_id:'run-id',
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(authorityReads, 2);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.notEqual(result.authority.revision, stagedRevision);
  assert.equal(result.graph.revision, authoritativeRevision);
  assert.deepEqual(calls.map((call) => call[0]), ['read', 'mutate', 'read', 'read', 'derive']);
  assert.equal(calls[1][4], '.overcenter/definitions/project.json');
  assert.match(calls[1][5], /^project-amend-v1:[0-9a-f]{64}$/);
});

test('empty project.amend confirms the current exact revision without provider mutation', async () => {
  let authorityReads = 0;
  let mutationCalls = 0;
  const calls = [];
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority:async () => ({ project_ref:projectRef, kind:'github', repository:'example/project', revision:(authorityReads += 1, initialRevision), derivation:'overcenter-project-graph-v1' }),
    readDefinitionFacts:async ({ revision }) => {
      calls.push(['read', revision]);
      return facts(revision);
    },
    applyChangeset:async () => {
      mutationCalls += 1;
      throw new Error('no-op amendment must not reach provider mutation');
    },
    deriveProjectGraph:async ({ authority }) => {
      calls.push(['derive', authority.revision]);
      return { schema:'overcenter-project-graph-v1', revision:authority.revision };
    },
  });

  const result = await adapter.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{},
  });

  assert.equal(authorityReads, 1);
  assert.equal(mutationCalls, 0);
  assert.equal(result.authority.revision, initialRevision);
  assert.deepEqual(result.diff, { added:[], changed:[], removed:[] });
  assert.equal(result.graph.revision, initialRevision);
  assert.deepEqual(calls.map((call) => call[0]), ['read', 'derive']);
});

test('idempotent transition upsert is a confirmed no-op without confirmation-history or provider mutation', async () => {
  let mutationCalls = 0;
  let historyReads = 0;
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority:async () => ({ project_ref:projectRef, kind:'github', repository:'example/project', revision:initialRevision, derivation:'overcenter-project-graph-v1' }),
    readDefinitionFacts:async ({ revision }) => facts(revision),
    readProjectObservations:async () => {
      historyReads += 1;
      return [];
    },
    applyChangeset:async () => {
      mutationCalls += 1;
      throw new Error('idempotent upsert must not reach provider mutation');
    },
    deriveProjectGraph:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }),
  });

  const result = await adapter.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[baseDefinition.transitions[0]] },
  });

  assert.equal(historyReads, 0);
  assert.equal(mutationCalls, 0);
  assert.equal(result.authority.revision, initialRevision);
  assert.deepEqual(result.diff, { added:[], changed:[], removed:[] });
});

test('semantic idempotency is internal, stable for replay, and separates material intent', async () => {
  const same = { project_ref:projectRef, expected_revision:initialRevision, amendment:{ upsert_transitions:[] } };
  const first = await projectAuthoringIdempotencyKey(same);
  const replay = await projectAuthoringIdempotencyKey({ ...same, amendment:{ upsert_transitions:[] } });
  const different = await projectAuthoringIdempotencyKey({ ...same, amendment:{ remove_transition_ids:['foundation'] } });
  assert.equal(first, replay);
  assert.notEqual(first, different);
});

test('project.define bootstraps on a work branch but returns success only after refreshed authority exposes the definition', async () => {
  const calls = [];
  let authorityReads = 0;
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority:async () => ({ project_ref:projectRef, kind:'github', repository:'example/project', revision:++authorityReads === 1 ? initialRevision : authoritativeRevision, derivation:'overcenter-project-graph-v1' }),
    readDefinitionFacts:async ({ revision }) => {
      calls.push(['read', revision]);
      if (revision === initialRevision) return { schema:'project-definition-facts-v1', repository:'example/project', revision, definitions:[] };
      return facts(revision, baseDefinition);
    },
    resolveMutationBranch:async () => ({ branch:'work/project-define', expected_head:initialRevision }),
    applyChangeset:async (request) => {
      calls.push(['mutate', request]);
      assert.equal(request.changes.length, 2);
      const discovery = request.changes.find((change) => change.path === '.overcenter/project-definitions.json');
      const definition = request.changes.find((change) => change.path === '.overcenter/definitions/project.json');
      assert.equal(discovery.operation, 'create');
      assert.equal(definition.operation, 'create');
      assert.deepEqual(JSON.parse(discovery.content), {
        schema:'project-definition-discovery-v1',
        definitions:['.overcenter/definitions/project.json'],
      });
      assert.deepEqual(JSON.parse(definition.content), baseDefinition);
      assert.match(request.idempotency_key, /^project-define-v1:[0-9a-f]{64}$/);
      return { ok:true, new_head:stagedRevision };
    },
    deriveProjectGraph:async ({ authority }) => {
      calls.push(['derive', authority.revision]);
      return { schema:'overcenter-project-graph-v1', revision:authority.revision };
    },
  });

  const result = await adapter.define({
    project_ref:projectRef,
    expected_revision:initialRevision,
    definition:baseDefinition,
  });

  assert.equal(authorityReads, 2);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.notEqual(result.authority.revision, stagedRevision);
  assert.deepEqual(result.diff, { added:['foundation'], changed:[], removed:[] });
  assert.deepEqual(calls.map((call) => call[0]), ['read', 'mutate', 'read', 'read', 'derive']);
});

test('exact-revision project facts can represent an adopted repository with no project definition yet', () => {
  const facts = normalizeProjectDefinitionFacts({
    schema:'project-definition-facts-v1',
    repository:'example/project',
    revision:initialRevision,
    definitions:[],
  });
  assert.deepEqual(facts.definitions, []);
});

test('exact GitHub reader treats only discovery 404 as definition-free bootstrap state', async () => {
  const client = { async call(name, input) {
    assert.equal(name, 'github');
    if (input.path === `/repos/example/project/commits/${initialRevision}`) return { status:200, body:{ sha:initialRevision } };
    if (input.path === '/repos/example/project/contents/.overcenter/project-definitions.json') return { status:404, body:{ message:'Not Found' } };
    throw new Error(`unexpected path ${input.path}`);
  } };
  const empty = await createProjectDefinitionFactsReader(client)({ repository:'example/project', revision:initialRevision });
  assert.deepEqual(empty.definitions, []);

  const forbidden = { async call(name, input) {
    if (input.path === `/repos/example/project/commits/${initialRevision}`) return { status:200, body:{ sha:initialRevision } };
    return { status:403, body:{ message:'Forbidden' } };
  } };
  await assert.rejects(
    () => createProjectDefinitionFactsReader(forbidden)({ repository:'example/project', revision:initialRevision }),
    (error) => error?.code === 'PROJECT_DEFINITION_FACTS_READ_FAILED',
  );
});