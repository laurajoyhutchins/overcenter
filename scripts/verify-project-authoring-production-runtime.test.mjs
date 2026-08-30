import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAuthoringProductionRuntime, createProjectAuthoringProductionRuntimeFromHost } from '../lib/project-authoring-production-runtime.js';
import { createProjectAuthoringHostRuntime } from '../lib/project-authoring-host-runtime.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const resultingRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const projectRef = 'github:example/project';
const baseDefinition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[{ id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }],
};

function facts(revision, definition = baseDefinition) {
  return { schema:'project-definition-facts-v1', repository:'example/project', revision, definitions:[{ path:'.overcenter/definitions/project.json', content:JSON.stringify(definition) }] };
}

test('runtime composition grants exact source mutation authority and routes authoring through the guarded GitHub writer', async () => {
  const calls = [];
  const runtime = createProjectAuthoringProductionRuntime({
    resolveAuthority:async () => ({ project_ref:projectRef, kind:'github', repository:'example/project', revision:initialRevision, derivation:'overcenter-project-graph-v1' }),
    readDefinitionFacts:async ({ revision }) => revision === resultingRevision
      ? facts(revision, { ...baseDefinition, transitions:[...baseDefinition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] })
      : facts(revision),
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    readSourceRevision:async () => initialRevision,
    applyChangeset:async (request, options) => {
      const authority = await options.executionAuthority.require({ repository:request.repo });
      calls.push({ request, authority });
      return { ok:true, new_head:resultingRevision };
    },
    deriveProjectGraph:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }),
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(result.authority.revision, resultingRevision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority.subject, 'project_definition');
  assert.equal(calls[0].authority.operation, 'amend');
  assert.equal(calls[0].authority.authority_revision, initialRevision);
  assert.equal('lease_ref' in calls[0].request, false);
  assert.equal('run_id' in calls[0].request, false);
});

test('runtime host binding consumes bounded capabilities instead of importing a concrete runtime host', async () => {
  const calls = [];
  const runtime = createProjectAuthoringProductionRuntimeFromHost({
    projectAuthority:{ resolve:async () => ({ project_ref:projectRef, kind:'github', repository:'example/project', revision:initialRevision, derivation:'overcenter-project-graph-v1' }) },
    definitionFacts:{ read:async ({ revision }) => revision === resultingRevision
      ? facts(revision, { ...baseDefinition, transitions:[...baseDefinition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] })
      : facts(revision) },
    repositoryDisposition:{ read:async (repository) => ({ repository, disposition:'ACTIVE' }) },
    sourceRevision:{ read:async () => initialRevision },
    githubChangeset:{ apply:async (request, options) => {
      const authority = await options.executionAuthority.require({ repository:request.repo });
      calls.push({ request, authority });
      return { ok:true, new_head:resultingRevision };
    } },
    projectGraph:{ derive:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }) },
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(result.authority.revision, resultingRevision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority.subject, 'project_definition');
});

test('runtime host binding can re-read source authority through projectAuthority instead of requiring a duplicate sourceRevision capability', async () => {
  const authorityReads = [];
  const runtime = createProjectAuthoringProductionRuntimeFromHost({
    projectAuthority:{ resolve:async ({ project_ref }) => {
      authorityReads.push(project_ref);
      return { project_ref, kind:'github', repository:'example/project', revision:initialRevision, derivation:'overcenter-project-graph-v1' };
    } },
    definitionFacts:{ read:async ({ revision }) => revision === resultingRevision
      ? facts(revision, { ...baseDefinition, transitions:[...baseDefinition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] })
      : facts(revision) },
    repositoryDisposition:{ read:async (repository) => ({ repository, disposition:'ACTIVE' }) },
    githubChangeset:{ apply:async (request, options) => {
      await options.executionAuthority.require({ repository:request.repo });
      return { ok:true, new_head:resultingRevision };
    } },
    projectGraph:{ derive:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }) },
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(result.authority.revision, resultingRevision);
  assert.deepEqual(authorityReads, [projectRef, projectRef]);
});

test('host adapter binds existing source authority, facts, disposition, changeset, and graph capabilities without importing the runtime host', async () => {
  const calls = [];
  const graphRuntime = {
    resolveProjectAuthority:async ({ project_ref }) => ({ project_ref, kind:'github', repository:'example/project', revision:initialRevision, derivation:'overcenter-project-graph-v1' }),
    readProjectFacts:async ({ revision }) => ({ schema:'project-authority-facts-v1', repository:'example/project', revision, facts:{ definition_facts:revision === resultingRevision
      ? facts(revision, { ...baseDefinition, transitions:[...baseDefinition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] })
      : facts(revision) } }),
  };
  const runtime = createProjectAuthoringHostRuntime({
    graphRuntime,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    applyGithubChangeset:async (request, options) => {
      const authority = await options.executionAuthority.require({ repository:request.repo });
      calls.push({ request, authority });
      return { ok:true, new_head:resultingRevision };
    },
    deriveProjectGraph:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }),
  });

  const result = await runtime.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  });

  assert.equal(result.authority.revision, resultingRevision);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].authority.subject, 'project_definition');
  assert.equal(calls[0].authority.authority_revision, initialRevision);
});

test('host adapter rejects stale authoritative source before any GitHub mutation', async () => {
  let mutations = 0;
  const graphRuntime = {
    resolveProjectAuthority:async ({ project_ref }) => ({ project_ref, kind:'github', repository:'example/project', revision:resultingRevision, derivation:'overcenter-project-graph-v1' }),
    readProjectFacts:async () => { throw new Error('stale authority must fail before definition readback'); },
  };
  const runtime = createProjectAuthoringHostRuntime({
    graphRuntime,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    applyGithubChangeset:async () => { mutations += 1; return { ok:true, new_head:'c'.repeat(40) }; },
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

test('hermetic GitHub capability replay converges on one physical source mutation', async () => {
  const requests = [];
  const committed = new Map();
  let physicalMutations = 0;
  const amendedDefinition = { ...baseDefinition, transitions:[...baseDefinition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] };
  const graphRuntime = {
    resolveProjectAuthority:async ({ project_ref }) => ({ project_ref, kind:'github', repository:'example/project', revision:initialRevision, derivation:'overcenter-project-graph-v1' }),
    readProjectFacts:async ({ revision }) => ({
      schema:'project-authority-facts-v1',
      repository:'example/project',
      revision,
      facts:{ definition_facts:revision === resultingRevision ? facts(revision, amendedDefinition) : facts(revision) },
    }),
  };
  const runtime = createProjectAuthoringHostRuntime({
    graphRuntime,
    readRepositoryDisposition:async (repository) => ({ repository, disposition:'ACTIVE' }),
    applyGithubChangeset:async (request, options) => {
      const authority = await options.executionAuthority.require({ repository:request.repo });
      assert.equal(authority.authority_revision, initialRevision);
      requests.push(request);
      const replay = committed.get(request.idempotency_key);
      if (replay) return replay;
      physicalMutations += 1;
      const result = { ok:true, new_head:resultingRevision };
      committed.set(request.idempotency_key, result);
      return result;
    },
    deriveProjectGraph:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }),
  });
  const input = {
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[{ id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] },
  };

  const first = await runtime.amend(input);
  const replay = await runtime.amend(input);

  assert.equal(physicalMutations, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].idempotency_key, requests[1].idempotency_key);
  assert.equal(requests[0].branch, requests[1].branch);
  assert.equal(first.authority.revision, resultingRevision);
  assert.equal(replay.authority.revision, resultingRevision);
  assert.equal(first.graph.revision, resultingRevision);
  assert.equal(replay.graph.revision, resultingRevision);
});