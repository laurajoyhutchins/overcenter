import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAuthoringProductionRuntime, createProjectAuthoringProductionRuntimeFromHost } from '../lib/project-authoring-production-runtime.js';
import { createProjectAuthoringHostRuntime } from '../lib/project-authoring-host-runtime.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const stagedRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const authoritativeRevision = 'cccccccccccccccccccccccccccccccccccccccc';
const projectRef = 'github:example/project';
const baseDefinition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[{ id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }],
};
const amendedDefinition = {
  ...baseDefinition,
  transitions:[...baseDefinition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }],
};

function facts(revision, definition = baseDefinition) {
  return { schema:'project-definition-facts-v1', repository:'example/project', revision, definitions:[{ path:'.overcenter/definitions/project.json', content:JSON.stringify(definition) }] };
}

function authority(revision, ref = projectRef) {
  return { project_ref:ref, kind:'github', repository:'example/project', revision, derivation:'overcenter-project-graph-v1' };
}

test('runtime composition grants exact source mutation authority and confirms success through refreshed repository authority', async () => {
  const calls = [];
  let authorityReads = 0;
  const runtime = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => authority(++authorityReads === 1 ? initialRevision : authoritativeRevision),
    readDefinitionFacts:async ({ revision }) => revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision),
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => initialRevision,
    applyChangeset:async (request, options) => {
      const mutationAuthority = await options.executionAuthority.require({ repository:request.repo });
      calls.push({ request, authority:mutationAuthority });
      return { ok:true, new_head:stagedRevision };
    },
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(authorityReads, 2);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.notEqual(result.authority.revision, stagedRevision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority.subject, 'project_definition');
  assert.equal(calls[0].authority.operation, 'amend');
  assert.equal(calls[0].authority.authority_revision, initialRevision);
  assert.equal('lease_ref' in calls[0].request, false);
  assert.equal('run_id' in calls[0].request, false);
});

test('runtime host binding consumes bounded capabilities and re-resolves authority after mutation', async () => {
  const calls = [];
  let authorityReads = 0;
  const runtime = createProjectAuthoringProductionRuntimeFromHost({
    projectAuthority:{ resolve:async () => authority(++authorityReads < 3 ? initialRevision : authoritativeRevision) },
    definitionFacts:{ read:async ({ revision }) => revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision) },
    repositoryDisposition:{ read:async (repository) => ({ repository, disposition:'ACTIVE' }) },
    githubChangeset:{ apply:async (request, options) => {
      const mutationAuthority = await options.executionAuthority.require({ repository:request.repo });
      calls.push({ request, authority:mutationAuthority });
      return { ok:true, new_head:stagedRevision };
    } },
    projectGraph:{ derive:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }) },
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(authorityReads, 3);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority.subject, 'project_definition');
});

test('runtime host binding reuses projectAuthority for mutation fencing and post-mutation authoritative readback', async () => {
  const authorityReads = [];
  const runtime = createProjectAuthoringProductionRuntimeFromHost({
    projectAuthority:{ resolve:async ({ project_ref }) => {
      authorityReads.push(project_ref);
      return authority(authorityReads.length < 3 ? initialRevision : authoritativeRevision, project_ref);
    } },
    definitionFacts:{ read:async ({ revision }) => revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision) },
    repositoryDisposition:{ read:async (repository) => ({ repository, disposition:'ACTIVE' }) },
    githubChangeset:{ apply:async (request, options) => {
      await options.executionAuthority.require({ repository:request.repo });
      return { ok:true, new_head:stagedRevision };
    } },
    projectGraph:{ derive:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }) },
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(result.authority.revision, authoritativeRevision);
  assert.deepEqual(authorityReads, [projectRef, projectRef, projectRef]);
});

test('host adapter binds source authority, facts, disposition, changeset, graph, and refreshed authority without importing the runtime host', async () => {
  const calls = [];
  let authorityReads = 0;
  const graphRuntime = {
    resolveProjectAuthority:async ({ project_ref }) => authority(++authorityReads < 3 ? initialRevision : authoritativeRevision, project_ref),
    readProjectFacts:async ({ revision }) => ({ schema:'project-authority-facts-v1', repository:'example/project', revision, facts:{ definition_facts:revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision) } }),
  };
  const runtime = createProjectAuthoringHostRuntime({
    graphRuntime,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    applyGithubChangeset:async (request, options) => {
      const mutationAuthority = await options.executionAuthority.require({ repository:request.repo });
      calls.push({ request, authority:mutationAuthority });
      return { ok:true, new_head:stagedRevision };
    },
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(authorityReads, 3);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority.subject, 'project_definition');
  assert.equal(calls[0].authority.authority_revision, initialRevision);
});

test('host adapter rejects stale authoritative source before any GitHub mutation', async () => {
  let mutations = 0;
  const graphRuntime = {
    resolveProjectAuthority:async ({ project_ref }) => authority(authoritativeRevision, project_ref),
    readProjectFacts:async () => { throw new Error('stale authority must fail before definition readback'); },
  };
  const runtime = createProjectAuthoringHostRuntime({
    graphRuntime,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    applyGithubChangeset:async () => { mutations += 1; return { ok:true, new_head:stagedRevision }; },
    deriveProjectGraph:async () => { throw new Error('stale authority must fail before graph derivation'); },
  });

  await assert.rejects(
    () => runtime.amend({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment:{ upsert_transitions:[] },
    }),
    (error) => error?.code === 'PROJECT_AUTHORING_AUTHORITY_STALE',
  );
  assert.equal(mutations, 0);
});

test('authoritative advancement rejects a stale semantic replay before a second physical source mutation', async () => {
  const requests = [];
  const committed = new Map();
  let physicalMutations = 0;
  let authorityReads = 0;
  const graphRuntime = {
    resolveProjectAuthority:async ({ project_ref }) => authority(++authorityReads <= 2 ? initialRevision : authoritativeRevision, project_ref),
    readProjectFacts:async ({ revision }) => ({
      schema:'project-authority-facts-v1',
      repository:'example/project',
      revision,
      facts:{ definition_facts:revision === authoritativeRevision ? facts(revision, amendedDefinition) : facts(revision) },
    }),
  };
  const runtime = createProjectAuthoringHostRuntime({
    graphRuntime,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    applyGithubChangeset:async (request, options) => {
      const mutationAuthority = await options.executionAuthority.require({ repository:request.repo });
      assert.equal(mutationAuthority.authority_revision, initialRevision);
      requests.push(request);
      const replay = committed.get(request.idempotency_key);
      if (replay) return replay;
      physicalMutations += 1;
      const result = { ok:true, new_head:stagedRevision };
      committed.set(request.idempotency_key, result);
      return result;
    },
    deriveProjectGraph:async ({ authority:observed }) => ({ schema:'overcenter-project-graph-v1', revision:observed.revision }),
  });
  const input = {
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  };

  const first = await runtime.amend(input);
  await assert.rejects(
    () => runtime.amend(input),
    (error) => error?.code === 'PROJECT_AUTHORING_AUTHORITY_STALE',
  );

  assert.equal(physicalMutations, 1);
  assert.equal(requests.length, 1);
  assert.equal(first.authority.revision, authoritativeRevision);
  assert.equal(first.graph.revision, authoritativeRevision);
});