import assert from 'node:assert/strict';
import test from 'node:test';

import { applyGithubChangeset, GitHubChangesetError } from '../lib/github-apply-changeset.js';

const SHA = {
  base: '1111111111111111111111111111111111111111',
  tree: '2222222222222222222222222222222222222222',
  nextTree: '3333333333333333333333333333333333333333',
  commit: '4444444444444444444444444444444444444444',
};

function ambiguousRefMutationWithFailedReadback() {
  let branchReads = 0;
  return {
    async resolveCommit() {
      return { sha: SHA.base, tree_sha: SHA.tree, message: 'base' };
    },
    async getBranch() {
      branchReads += 1;
      if (branchReads >= 3) {
        throw new GitHubChangesetError(
          'GITHUB_UPSTREAM_ERROR',
          'reconciliation read failed',
          { phase:'reconcile.ref_readback', may_have_mutated:false },
          502,
        );
      }
      return null;
    },
    async getPathEntries(_repo, _treeSha, paths) {
      return new Map(paths.map(path => [path, null]));
    },
    async createTree() {
      return SHA.nextTree;
    },
    async createCommit() {
      return SHA.commit;
    },
    async createBranch() {
      throw new GitHubChangesetError(
        'GITHUB_UPSTREAM_ERROR',
        'ref mutation response was lost',
        {
          phase:'mutation.ref_update',
          github_request_id:'REQ-MUTATION',
          may_have_mutated:true,
        },
        502,
      );
    },
  };
}

test('failed reconciliation cannot downgrade an ambiguous GitHub ref mutation', async () => {
  const result = await applyGithubChangeset({
    repo:'laurajoyhutchins/test',
    base_sha:SHA.base,
    branch:'chore/test-change',
    changes:[{ path:'new.txt', operation:'create', content:'hello\n' }],
    commit_message:'chore: test mutation certainty',
  }, {
    github:ambiguousRefMutationWithFailedReadback(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.may_have_mutated, true);
  assert.equal(result.phase, 'mutation.ref_update');
  assert.equal(result.github_request_id, 'REQ-MUTATION');
  assert.equal(result.reconciliation_error?.error, 'GITHUB_UPSTREAM_ERROR');
  assert.equal(result.reconciliation_error?.phase, 'reconcile.ref_readback');
});
