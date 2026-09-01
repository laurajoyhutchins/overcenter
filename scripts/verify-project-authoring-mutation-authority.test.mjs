import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectAuthoringGithubAdapter } from '../lib/project-authoring-github-runtime.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const stagedRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const authoritativeRevision = 'cccccccccccccccccccccccccccccccccccccccc';
const projectRef = 'github:example/project';
const definition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[{ id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }],
};

function facts(revision, definitions) {
  return { schema:'project-definition-facts-v1', repository:'example/project', revision, definitions };
}

function sourceAuthority(operation) {
  return {
    schema:'project-definition-mutation-authority-v1',
    subject:'project_definition',
    operation,
    project_ref:projectRef,
    repository:'example/project',
    authority_revision:initialRevision,
  };
}

function projectAuthority(revision) {
  return { project_ref:projectRef, kind:'github', repository:'example/project', revision, derivation:'overcenter-project-graph-v1' };
}

test('project.define resolves bootstrap source mutation authority internally before GitHub mutation', async () => {
  const authorityCalls = [];
  let projectAuthorityReads = 0;
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority:async () => projectAuthority(++projectAuthorityReads === 1 ? initialRevision : authoritativeRevision),
    readDefinitionFacts:async ({ revision }) => revision === initialRevision
      ? facts(revision, [])
      : facts(revision, [{ path:'.overcenter/definitions/project.json', content:JSON.stringify(definition) }]),
    resolveMutationBranch:async () => ({ branch:'work/project-define', expected_head:initialRevision }),
    resolveMutationAuthority:async (request) => {
      authorityCalls.push(request);
      return sourceAuthority('define');
    },
    applyChangeset:async (request) => {
      assert.equal(request.lease_ref, undefined);
      assert.equal(request.run_id, undefined);
      assert.deepEqual(request.mutation_authority, sourceAuthority('define'));
      return { ok:true, new_head:stagedRevision };
    },
    deriveProjectGraph:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }),
  });

  const result = await adapter.define({ project_ref:projectRef, expected_revision:initialRevision, definition });
  assert.equal(projectAuthorityReads, 2);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.notEqual(result.authority.revision, stagedRevision);
  assert.deepEqual(authorityCalls, [{
    operation:'define',
    project_ref:projectRef,
    repository:'example/project',
    expected_revision:initialRevision,
  }]);
});

test('project.amend resolves source mutation authority internally instead of accepting caller lease bookkeeping', async () => {
  const amended = { ...definition, transitions:[...definition.transitions, { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } }] };
  const authorityCalls = [];
  let projectAuthorityReads = 0;
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority:async () => projectAuthority(++projectAuthorityReads === 1 ? initialRevision : authoritativeRevision),
    readDefinitionFacts:async ({ revision }) => facts(revision, [{ path:'.overcenter/definitions/project.json', content:JSON.stringify(revision === authoritativeRevision ? amended : definition) }]),
    resolveMutationBranch:async () => ({ branch:'work/project-amend', expected_head:initialRevision }),
    resolveMutationAuthority:async (request) => {
      authorityCalls.push(request);
      return sourceAuthority('amend');
    },
    applyChangeset:async (request) => {
      assert.equal(request.lease_ref, undefined);
      assert.equal(request.run_id, undefined);
      assert.deepEqual(request.mutation_authority, sourceAuthority('amend'));
      return { ok:true, new_head:stagedRevision };
    },
    deriveProjectGraph:async ({ authority }) => ({ schema:'overcenter-project-graph-v1', revision:authority.revision }),
  });

  const result = await adapter.amend({
    project_ref:projectRef,
    expected_revision:initialRevision,
    amendment:{ upsert_transitions:[amended.transitions[1]] },
  });
  assert.equal(projectAuthorityReads, 2);
  assert.equal(result.authority.revision, authoritativeRevision);
  assert.notEqual(result.authority.revision, stagedRevision);
  assert.deepEqual(authorityCalls, [{
    operation:'amend',
    project_ref:projectRef,
    repository:'example/project',
    expected_revision:initialRevision,
  }]);
});
