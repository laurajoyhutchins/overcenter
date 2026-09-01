import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = path.join(root, 'node_modules');
const libAlias = path.join(nodeModules, 'lib');
const hatchableStub = path.join(nodeModules, 'hatchable');
const created = [];

fs.mkdirSync(nodeModules, { recursive:true });
if (!fs.existsSync(libAlias)) {
  fs.symlinkSync(path.join(root, 'lib'), libAlias, 'dir');
  created.push(libAlias);
}
if (!fs.existsSync(hatchableStub)) {
  fs.mkdirSync(hatchableStub, { recursive:true });
  fs.writeFileSync(path.join(hatchableStub, 'package.json'), JSON.stringify({ name:'hatchable', type:'module', exports:'./index.js' }));
  fs.writeFileSync(path.join(hatchableStub, 'index.js'), [
    'export const api = {};',
    'export const db = {};',
    'export const config = { get() { throw new Error("hatchable config is unavailable in focused Node regression"); } };',
  ].join('\n'));
  created.push(hatchableStub);
}

const { applyGithubChangeset, GitHubChangesetError } = await import('../lib/github-apply-changeset.js');

test.after(() => {
  for (const target of created.reverse()) fs.rmSync(target, { recursive:true, force:true });
});

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
