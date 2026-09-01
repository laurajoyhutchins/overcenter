import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createProjectAuthoringGithubAdapter } from '../lib/project-authoring-github-runtime.js';

await mkdir('node_modules/hatchable', { recursive:true });
await writeFile('node_modules/hatchable/package.json', JSON.stringify({ type:'module', exports:'./index.js' }));
await writeFile('node_modules/hatchable/index.js', `
export const api = {};
export const db = {};
export const config = {};
export const run = {};
export const agent = {};
export const tasks = {};
export const scheduler = {};
export const storage = {};
export const email = {};
export const ai = {};
export const browser = {};
export const knowledge = {};
export const memory = {};
export const cache = {};
export const auth = {};
export const approval = {};
`);
try { await symlink('../lib', 'node_modules/lib', 'dir'); } catch (error) {
  if (error?.code !== 'EEXIST') throw error;
}

const { applyGithubChangeset, GitHubChangesetError } = await import('../lib/github-apply-changeset.js');

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

// Production change that makes this pass: preserve the ambiguous write evidence when reconciliation itself throws.
test('github changeset cannot downgrade an ambiguous ref write when reconciliation also fails', async () => {
  const baseSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const baseTree = 'cccccccccccccccccccccccccccccccccccccccc';
  const nextTree = 'dddddddddddddddddddddddddddddddddddddddd';
  const commitSha = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  let refMutationAttempts = 0;

  const github = {
    resolveCommit:async () => ({ sha:baseSha, tree_sha:baseTree }),
    getBranch:async (_repo, _branch, options = {}) => {
      if (options.phase === 'reconcile.ref_readback') {
        throw new GitHubChangesetError(
          'GITHUB_TRANSPORT_ERROR',
          'reconciliation read failed',
          {
            phase:'reconcile.ref_readback',
            github_request_id:'REQ-READBACK',
            may_have_mutated:false,
          },
          502,
        );
      }
      return null;
    },
    getPathEntries:async (_repo, _treeSha, paths) => new Map(paths.map(path => [path, null])),
    createTree:async () => nextTree,
    createCommit:async () => commitSha,
    createBranch:async () => {
      refMutationAttempts += 1;
      throw new GitHubChangesetError(
        'GITHUB_TRANSPORT_ERROR',
        'ref write transport failed after dispatch',
        {
          phase:'mutation.ref_update',
          github_request_id:'REQ-WRITE',
          may_have_mutated:true,
        },
        502,
      );
    },
    updateBranch:async () => {
      throw new Error('updateBranch should not run for a new branch');
    },
  };

  const result = await applyGithubChangeset({
    repo:'example/project',
    base_sha:baseSha,
    branch:'feat/certainty-regression',
    expected_head:baseSha,
    changes:[{ path:'new.txt', operation:'create', content:'hello\n' }],
    commit_message:'test: reproduce ambiguous ref write',
  }, { github });

  assert.equal(refMutationAttempts, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'GITHUB_TRANSPORT_ERROR');
  assert.equal(result.phase, 'mutation.ref_update');
  assert.equal(result.github_request_id, 'REQ-WRITE');
  assert.equal(result.may_have_mutated, true);
});
