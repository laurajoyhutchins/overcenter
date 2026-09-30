import { observeCertifiedGitHubRead, type CertifiedGitHubReadEvidence } from './certified-read.ts';
import {
  observeCertifiedGitHubRepository,
  type CertifiedGitHubRepositoryEvidence,
} from './certified-repository.ts';
import {
  GitHubAsyncReadRequired,
  githubGet,
  isGitHubObjectId,
  sameGitHubObjectId,
  type GitHubJsonGet,
} from './rest.ts';

interface RepositoryCertifiedReadEvidence extends CertifiedGitHubReadEvidence {
  repository_id: number;
  repository: CertifiedGitHubRepositoryEvidence;
}

function repositoryCertifiedRead(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    operation,
    parameters,
    observerId,
    get,
    clock,
  }: {
    repositoryId: number;
    repositoryFullName: string;
    operation: 'ref' | 'pull_request';
    parameters: Record<string, string | number | boolean>;
    observerId: string;
    get: GitHubJsonGet;
    clock: () => string;
  },
): { value: unknown; evidence: RepositoryCertifiedReadEvidence } {
  const repository = observeCertifiedGitHubRepository(token, {
    repositoryId,
    repositoryFullName,
    get,
    clock,
    observerId,
  });
  const read = observeCertifiedGitHubRead(token, {
    repositoryFullName: repository.fact.object.full_name,
    operation,
    parameters,
    get,
    clock,
    observerId,
  });
  if (read.state !== 'observed') throw new Error('GITHUB_CERTIFIED_SINGLETON_READ_REQUIRED');
  return {
    value: read.value,
    evidence: {
      ...read.evidence,
      repository_id: repositoryId,
      requested_repository_full_name: repositoryFullName,
      repository: repository.evidence,
    },
  };
}

export interface GitHubRefPredicateResult {
  current: boolean;
  actual_sha: string;
  object_kind: 'github.commit' | 'github.tag';
}

export interface CertifiedGitHubRefEvidence extends RepositoryCertifiedReadEvidence {
  requested_ref: string;
  canonical_ref: string;
  object_kind: 'github.commit' | 'github.tag';
  actual_sha: string;
}

export interface CertifiedGitHubRefFenceResult {
  state: 'CURRENT' | 'STALE' | 'INDETERMINATE';
  reason: 'AUTHORITATIVE_BINDING_MATCHES' | 'AUTHORITATIVE_BINDING_DIFFERS' | 'OBSERVATION_FAILED';
  repository_full_name?: string;
  ref: string;
  expected_sha: string;
  actual_sha?: string;
  evidence?: CertifiedGitHubRefEvidence;
  observation_error?: string;
}

export function canonicalGitHubRef(ref: string): string {
  if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) return ref;
  if (ref.startsWith('heads/') || ref.startsWith('tags/')) return `refs/${ref}`;
  throw new Error('GITHUB_REF_COORDINATE_INVALID');
}

export function evaluateCertifiedGitHubRef(
  value: unknown,
  canonicalRef: string,
  expectedSha: string,
): GitHubRefPredicateResult {
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

export function observeCertifiedGitHubRefFence(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    ref,
    expectedSha,
    get = githubGet,
    clock = () => new Date().toISOString(),
  }: {
    repositoryId: number;
    repositoryFullName: string;
    ref: string;
    expectedSha: string;
    get?: GitHubJsonGet;
    clock?: () => string;
  },
): CertifiedGitHubRefFenceResult {
  if (!isGitHubObjectId(expectedSha)) throw new Error('GITHUB_REF_EXPECTED_SHA_INVALID');
  const canonicalRef = canonicalGitHubRef(ref);
  const requestedRef = canonicalRef.slice('refs/'.length);
  try {
    const read = repositoryCertifiedRead(token, {
      repositoryId,
      repositoryFullName,
      operation: 'ref',
      parameters: { ref: requestedRef },
      observerId: 'github-ref-fence/v1',
      get,
      clock,
    });
    const predicate = evaluateCertifiedGitHubRef(read.value, canonicalRef, expectedSha);
    return {
      state: predicate.current ? 'CURRENT' : 'STALE',
      reason: predicate.current ? 'AUTHORITATIVE_BINDING_MATCHES' : 'AUTHORITATIVE_BINDING_DIFFERS',
      repository_full_name: read.evidence.repository.canonical_full_name,
      ref: canonicalRef,
      expected_sha: expectedSha,
      actual_sha: predicate.actual_sha,
      evidence: {
        ...read.evidence,
        requested_ref: requestedRef,
        canonical_ref: canonicalRef,
        object_kind: predicate.object_kind,
        actual_sha: predicate.actual_sha,
      },
    };
  } catch (error: unknown) {
    return {
      state: 'INDETERMINATE',
      reason: 'OBSERVATION_FAILED',
      ref: canonicalRef,
      expected_sha: expectedSha,
      observation_error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface GitHubPullRequestExpectedIdentity {
  node_id: string;
  state: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
}

export interface GitHubPullRequestActualIdentity extends GitHubPullRequestExpectedIdentity {
  id: number;
}

export interface GitHubPullRequestIdentityPredicateResult {
  actual: GitHubPullRequestActualIdentity;
  differences: string[];
}

export interface CertifiedGitHubPullRequestEvidence extends RepositoryCertifiedReadEvidence {
  pull_number: number;
  pull_id: number;
  node_id: string;
  state: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
}

export interface CertifiedGitHubPullRequestIdentityResult {
  state: 'CURRENT' | 'STALE' | 'INDETERMINATE';
  reason:
    | 'AUTHORITATIVE_PR_IDENTITY_MATCHES'
    | 'AUTHORITATIVE_PR_IDENTITY_DIFFERS'
    | 'OBSERVATION_FAILED';
  repository_full_name?: string;
  pull_number: number;
  expected: GitHubPullRequestExpectedIdentity;
  actual?: GitHubPullRequestActualIdentity;
  differences?: string[];
  evidence?: CertifiedGitHubPullRequestEvidence;
  observation_error?: string;
}

function validateExpected(expected: GitHubPullRequestExpectedIdentity): void {
  if (!expected.node_id) throw new Error('GITHUB_PR_NODE_ID_REQUIRED');
  if (!expected.state) throw new Error('GITHUB_PR_STATE_REQUIRED');
  if (!isGitHubObjectId(expected.head_sha)) throw new Error('GITHUB_PR_HEAD_SHA_INVALID');
  if (!expected.base_ref) throw new Error('GITHUB_PR_BASE_REF_REQUIRED');
  if (!isGitHubObjectId(expected.base_sha)) throw new Error('GITHUB_PR_BASE_SHA_INVALID');
}

export function evaluateCertifiedGitHubPullRequestIdentity(
  value: unknown,
  pullNumber: number,
  expected: GitHubPullRequestExpectedIdentity,
): GitHubPullRequestIdentityPredicateResult {
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

export function observeCertifiedGitHubPullRequestIdentity(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    pullNumber,
    expected,
    get = githubGet,
    clock = () => new Date().toISOString(),
  }: {
    repositoryId: number;
    repositoryFullName: string;
    pullNumber: number;
    expected: GitHubPullRequestExpectedIdentity;
    get?: GitHubJsonGet;
    clock?: () => string;
  },
): CertifiedGitHubPullRequestIdentityResult {
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0)
    throw new Error('GITHUB_PR_NUMBER_INVALID');
  validateExpected(expected);
  try {
    const read = repositoryCertifiedRead(token, {
      repositoryId,
      repositoryFullName,
      operation: 'pull_request',
      parameters: { pull_number: pullNumber },
      observerId: 'github-pr-identity/v1',
      get,
      clock,
    });
    const predicate = evaluateCertifiedGitHubPullRequestIdentity(read.value, pullNumber, expected);
    return {
      state: predicate.differences.length === 0 ? 'CURRENT' : 'STALE',
      reason:
        predicate.differences.length === 0
          ? 'AUTHORITATIVE_PR_IDENTITY_MATCHES'
          : 'AUTHORITATIVE_PR_IDENTITY_DIFFERS',
      repository_full_name: read.evidence.repository.canonical_full_name,
      pull_number: pullNumber,
      expected,
      actual: predicate.actual,
      differences: predicate.differences,
      evidence: {
        ...read.evidence,
        pull_number: pullNumber,
        pull_id: predicate.actual.id,
        node_id: predicate.actual.node_id,
        state: predicate.actual.state,
        head_sha: predicate.actual.head_sha,
        base_ref: predicate.actual.base_ref,
        base_sha: predicate.actual.base_sha,
      },
    };
  } catch (error: unknown) {
    if (error instanceof GitHubAsyncReadRequired) throw error;
    return {
      state: 'INDETERMINATE',
      reason: 'OBSERVATION_FAILED',
      pull_number: pullNumber,
      expected,
      observation_error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface GitHubCommitAncestryPredicateResult {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  ahead_by: number;
  behind_by: number;
  merge_base_sha: string;
  relation: 'ancestor' | 'not-ancestor';
}

export interface CertifiedGitHubCommitAncestryEvidence extends CertifiedGitHubReadEvidence {
  ancestor_sha: string;
  descendant_sha: string;
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  ahead_by: number;
  behind_by: number;
  merge_base_sha: string;
  relation: 'ancestor' | 'not-ancestor';
}

export interface CertifiedGitHubCommitAncestryResult {
  state: 'ancestor' | 'not-ancestor';
  evidence: CertifiedGitHubCommitAncestryEvidence;
}

export function evaluateCertifiedGitHubCommitAncestry(
  value: unknown,
  ancestorSha: string,
): GitHubCommitAncestryPredicateResult {
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

export function observeCertifiedGitHubCommitAncestry(
  token: string,
  {
    repositoryFullName,
    ancestorSha,
    descendantSha,
    get,
    clock = () => new Date().toISOString(),
  }: {
    repositoryFullName: string;
    ancestorSha: string;
    descendantSha: string;
    get: GitHubJsonGet;
    clock?: () => string;
  },
): CertifiedGitHubCommitAncestryResult {
  if (!isGitHubObjectId(ancestorSha) || !isGitHubObjectId(descendantSha)) {
    throw new Error('GITHUB_COMMIT_ANCESTRY_SHA_INVALID');
  }
  const read = observeCertifiedGitHubRead(token, {
    repositoryFullName,
    operation: 'compare_commits',
    parameters: { basehead: `${ancestorSha}...${descendantSha}` },
    get,
    clock,
    observerId: 'github-pull-request-branch-updated/v1',
  });
  if (read.state !== 'observed')
    throw new Error('GITHUB_COMMIT_ANCESTRY_UNEXPECTED_COLLECTION_OBSERVATION');
  const predicate = evaluateCertifiedGitHubCommitAncestry(read.value, ancestorSha);
  return {
    state: predicate.relation,
    evidence: {
      ...read.evidence,
      ancestor_sha: ancestorSha,
      descendant_sha: descendantSha,
      status: predicate.status,
      ahead_by: predicate.ahead_by,
      behind_by: predicate.behind_by,
      merge_base_sha: predicate.merge_base_sha,
      relation: predicate.relation,
    },
  };
}
