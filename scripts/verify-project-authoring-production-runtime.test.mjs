import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAuthoringProductionRuntime, createProjectAuthoringProductionRuntimeFromHost } from '../lib/project-authoring-production-runtime.js';

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