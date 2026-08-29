import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectAuthoringGithubAdapter,
  projectAuthoringIdempotencyKey,
} from '../lib/project-authoring-github-runtime.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const resultingRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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

test('GitHub-backed authoring discovers definition path internally, fences mutation, and rereads resulting authority', async () => {
  const calls = [];
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority:async () => ({ project_ref:projectRef, kind:'github', repository:'example/project', revision:initialRevision, derivation:'overcenter-project-graph-v1' }),
    readDefinitionFacts:async ({ repository, revision }) => {
      calls.push(['read', repository, revision]);
      const definition = revision === resultingRevision
        ? { ...baseDefinition, transitions:[...baseDefinition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] }
        : baseDefinition;
      return facts(revision, definition);
    },
    resolveMutationBranch:async () => ({ branch:'work/project-amend', expected_head:initialRevision }),
    applyChangeset:async (request) => {
      calls.push(['mutate', request.repo, request.base_sha, request.expected_head, request.changes[0].path, request.idempotency_key]);
      assert.equal(request.changes[0].content.endsWith('\n'), true);
      assert.deepEqual(JSON.parse(request.changes[0].content).transitions.map((item) => item.id), ['foundation', 'second']);
      return { ok:true, new_head:resultingRevision };
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

  assert.equal(result.authority.revision, resultingRevision);
  assert.equal(result.graph.revision, resultingRevision);
  assert.deepEqual(calls.map((call) => call[0]), ['read', 'mutate', 'read', 'derive']);
  assert.equal(calls[1][4], '.overcenter/definitions/project.json');
  assert.match(calls[1][5], /^project-amend-v1:[0-9a-f]{64}$/);
});

test('semantic idempotency is internal, stable for replay, and separates material intent', async () => {
  const same = { project_ref:projectRef, expected_revision:initialRevision, amendment:{ upsert_transitions:[] } };
  const first = await projectAuthoringIdempotencyKey(same);
  const replay = await projectAuthoringIdempotencyKey({ ...same, amendment:{ upsert_transitions:[] } });
  const different = await projectAuthoringIdempotencyKey({ ...same, amendment:{ remove_transition_ids:['foundation'] } });
  assert.equal(first, replay);
  assert.notEqual(first, different);
});

test('project.define bootstraps discovery plus canonical definition without caller-authored paths', async () => {
  const calls = [];
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority:async () => ({ project_ref:projectRef, kind:'github', repository:'example/project', revision:initialRevision, derivation:'overcenter-project-graph-v1' }),
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
      return { ok:true, new_head:resultingRevision };
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

  assert.equal(result.authority.revision, resultingRevision);
  assert.deepEqual(result.diff, { added:['foundation'], changed:[], removed:[] });
  assert.deepEqual(calls.map((call) => call[0]), ['read', 'mutate', 'read', 'derive']);
});