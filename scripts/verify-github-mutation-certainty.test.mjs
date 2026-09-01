import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectAuthoringGithubAdapter } from '../lib/project-authoring-github-runtime.js';

const initialRevision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const projectRef = 'github:example/project';
const baseDefinition = {
  schema:'overcenter-project-definition-v1',
  project_ref:projectRef,
  transitions:[
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};

function facts() {
  return {
    schema:'project-definition-facts-v1',
    repository:'example/project',
    revision:initialRevision,
    definitions:[
      { path:'.overcenter/definitions/project.json', content:JSON.stringify(baseDefinition) },
    ],
  };
}

test('project.amend cannot downgrade failed reconciliation after a possible mutation', async () => {
  let deriveCalls = 0;
  const adapter = createProjectAuthoringGithubAdapter({
    resolveAuthority:async () => ({
      project_ref:projectRef,
      kind:'github',
      repository:'example/project',
      revision:initialRevision,
      derivation:'overcenter-project-graph-v1',
    }),
    readDefinitionFacts:async () => facts(),
    applyChangeset:async () => ({
      ok:false,
      error:'GITHUB_UPSTREAM_ERROR',
      message:'reconciliation read failed after an ambiguous ref mutation',
      phase:'reconcile.ref_readback',
      may_have_mutated:false,
      github_request_id:'REQ-READBACK',
    }),
    deriveProjectGraph:async () => {
      deriveCalls += 1;
      throw new Error('deriveProjectGraph must not run after an unconfirmed mutation');
    },
  });

  let failure;
  try {
    await adapter.amend({
      project_ref:projectRef,
      expected_revision:initialRevision,
      amendment:{
        upsert_transitions:[
          { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
        ],
      },
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.equal(failure.code, 'PROJECT_AUTHORING_MUTATION_UNCONFIRMED');
  assert.equal(failure.may_have_mutated, true);
  assert.equal(failure.details?.may_have_mutated, true);
  assert.equal(failure.details?.mutation_certainty, 'possible');
  assert.equal(failure.details?.result?.phase, 'reconcile.ref_readback');
  assert.equal(failure.details?.result?.may_have_mutated, false);
  assert.equal(deriveCalls, 0);
});
