import { isGitHubObjectId, sameGitHubObjectId } from './rest.ts';

export function canonicalGitHubRef(ref: string): string {
  if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) return ref;
  if (ref.startsWith('heads/') || ref.startsWith('tags/')) return `refs/${ref}`;
  throw new Error('GITHUB_REF_COORDINATE_INVALID');
}

export function evaluateCertifiedGitHubRef(
  value: unknown,
  canonicalRef: string,
  expectedSha: string,
) {
  if (!isGitHubObjectId(expectedSha)) throw new Error('GITHUB_REF_EXPECTED_SHA_INVALID');
  const observed = value as { ref: string; object: { type: string; sha: string } };
  if (!['commit', 'tag'].includes(observed.object.type))
    throw new Error('GITHUB_REF_OBJECT_TYPE_INVALID');
  if (!isGitHubObjectId(observed.object.sha)) throw new Error('GITHUB_REF_OBJECT_SHA_INVALID');
  if (canonicalGitHubRef(observed.ref) !== canonicalRef) {
    throw new Error('GITHUB_REF_RESPONSE_COORDINATE_MISMATCH');
  }
  return {
    current: sameGitHubObjectId(observed.object.sha, expectedSha),
    actual_sha: observed.object.sha,
    object_kind: observed.object.type === 'commit' ? 'github.commit' : 'github.tag',
  };
}

export interface GitHubPullRequestExpectedIdentity {
  node_id: string;
  state: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
}

export function evaluateCertifiedGitHubPullRequestIdentity(
  value: unknown,
  pullNumber: number,
  expected: GitHubPullRequestExpectedIdentity,
) {
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0)
    throw new Error('GITHUB_PR_NUMBER_INVALID');
  if (!expected.node_id) throw new Error('GITHUB_PR_NODE_ID_REQUIRED');
  if (!expected.state) throw new Error('GITHUB_PR_STATE_REQUIRED');
  if (!isGitHubObjectId(expected.head_sha)) throw new Error('GITHUB_PR_HEAD_SHA_INVALID');
  if (!expected.base_ref) throw new Error('GITHUB_PR_BASE_REF_REQUIRED');
  if (!isGitHubObjectId(expected.base_sha)) throw new Error('GITHUB_PR_BASE_SHA_INVALID');

  const observed = value as {
    id: number;
    node_id: string;
    number: number;
    state: string;
    head: { sha: string };
    base: { ref: string; sha: string };
  };
  if (observed.id <= 0 || observed.node_id.length === 0 || observed.number !== pullNumber) {
    throw new Error('GITHUB_PR_IDENTITY_INVALID');
  }
  if (!isGitHubObjectId(observed.head.sha) || !isGitHubObjectId(observed.base.sha)) {
    throw new Error('GITHUB_PR_REVISION_INVALID');
  }

  const actual = {
    id: observed.id,
    node_id: observed.node_id,
    state: observed.state,
    head_sha: observed.head.sha,
    base_ref: observed.base.ref,
    base_sha: observed.base.sha,
  };
  const differences: string[] = [];
  if (actual.node_id !== expected.node_id) differences.push('node_id');
  if (actual.state !== expected.state) differences.push('state');
  if (!sameGitHubObjectId(actual.head_sha, expected.head_sha)) differences.push('head_sha');
  if (actual.base_ref !== expected.base_ref) differences.push('base_ref');
  if (!sameGitHubObjectId(actual.base_sha, expected.base_sha)) differences.push('base_sha');
  return { actual, differences };
}

export function evaluateCertifiedGitHubCommitAncestry(value: unknown, ancestorSha: string) {
  if (!isGitHubObjectId(ancestorSha)) throw new Error('GITHUB_COMMIT_ANCESTRY_SHA_INVALID');
  const observed = value as {
    status: 'ahead' | 'behind' | 'diverged' | 'identical';
    ahead_by: number;
    behind_by: number;
    base_commit: { sha: string };
    merge_base_commit: { sha: string };
  };
  if (
    !['ahead', 'behind', 'diverged', 'identical'].includes(observed.status) ||
    !Number.isSafeInteger(observed.ahead_by) ||
    observed.ahead_by < 0 ||
    !Number.isSafeInteger(observed.behind_by) ||
    observed.behind_by < 0 ||
    !isGitHubObjectId(observed.base_commit?.sha) ||
    !sameGitHubObjectId(observed.base_commit.sha, ancestorSha) ||
    !isGitHubObjectId(observed.merge_base_commit?.sha)
  ) {
    throw new Error('GITHUB_COMMIT_ANCESTRY_OBSERVATION_INVALID');
  }
  const relation =
    (observed.status === 'ahead' || observed.status === 'identical') &&
    observed.behind_by === 0 &&
    sameGitHubObjectId(observed.merge_base_commit.sha, ancestorSha)
      ? ('ancestor' as const)
      : ('not-ancestor' as const);
  return {
    status: observed.status,
    ahead_by: observed.ahead_by,
    behind_by: observed.behind_by,
    merge_base_sha: observed.merge_base_commit.sha,
    relation,
  };
}
