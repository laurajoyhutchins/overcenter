import assert from 'node:assert/strict';
import test from 'node:test';
import { observeCertifiedGitHubCommitAncestry } from '../src/providers/github/certified-ancestry.ts';

const ANCESTOR = 'a'.repeat(40);
const DESCENDANT = 'b'.repeat(40);
const OBSERVED_AT = '2026-10-05T20:40:00.000Z';

function observe(
  status: 'ahead' | 'behind' | 'diverged' | 'identical',
  aheadBy: number,
  behindBy: number,
  mergeBaseSha = ANCESTOR,
  descendantSha = DESCENDANT,
) {
  return observeCertifiedGitHubCommitAncestry('token', {
    repositoryFullName: 'acme/widget',
    ancestorSha: ANCESTOR,
    descendantSha,
    clock: () => OBSERVED_AT,
    get: (_token, path) => {
      assert.equal(path, `/repos/acme/widget/compare/${ANCESTOR}...${descendantSha}`);
      return {
        status,
        ahead_by: aheadBy,
        behind_by: behindBy,
        base_commit: { sha: ANCESTOR },
        merge_base_commit: { sha: mergeBaseSha },
      };
    },
  });
}

test('certified ancestry preserves an ahead ancestor and evidence coordinates', () => {
  const result = observe('ahead', 3, 0);

  assert.equal(result.state, 'ancestor');
  assert.equal(result.evidence.relation, 'ancestor');
  assert.equal(result.evidence.operation_id, 'repos/compare-commits');
  assert.equal(result.evidence.observed_at, OBSERVED_AT);
  assert.equal(result.evidence.requested_repository_full_name, 'acme/widget');
  assert.equal(
    result.evidence.request_path,
    `/repos/acme/widget/compare/${ANCESTOR}...${DESCENDANT}`,
  );
  assert.equal(result.evidence.ancestor_sha, ANCESTOR);
  assert.equal(result.evidence.descendant_sha, DESCENDANT);
  assert.equal(result.evidence.merge_base_sha, ANCESTOR);
});

test('certified ancestry treats an identical revision as ancestor', () => {
  const result = observe('identical', 0, 0, ANCESTOR, ANCESTOR);

  assert.equal(result.state, 'ancestor');
  assert.equal(result.evidence.status, 'identical');
  assert.equal(result.evidence.descendant_sha, ANCESTOR);
  assert.equal(result.evidence.relation, 'ancestor');
});

test('certified ancestry rejects a diverged relation', () => {
  const result = observe('diverged', 2, 1, 'c'.repeat(40));

  assert.equal(result.state, 'not-ancestor');
  assert.equal(result.evidence.status, 'diverged');
  assert.equal(result.evidence.relation, 'not-ancestor');
});
