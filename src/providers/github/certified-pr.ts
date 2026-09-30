import {
  observeCertifiedGitHubSemanticRead,
  type CertifiedGitHubSemanticReadEvidence,
} from './certified-read.ts';
import {
  GitHubAsyncReadRequired,
  githubGet,
  isGitHubObjectId,
  sameGitHubObjectId,
  type GitHubJsonGet,
} from './rest.ts';

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

export interface CertifiedGitHubPullRequestEvidence {
  provider: 'github';
  api_version: string;
  schema_sha256: string;
  schema_source_commit: string;
  observer: { kind: 'git-kernel'; id: 'github-pr-identity/v1' };
  repository_id: number;
  requested_repository_full_name: string;
  repository: CertifiedGitHubSemanticReadEvidence['repository'];
  operation_id: 'pulls/get';
  observed_at: string;
  pull_number: number;
  pull_id: number;
  node_id: string;
  state: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
  validated_paths: string[];
  optional_absent_paths: string[];
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

  const actual: GitHubPullRequestActualIdentity = {
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

function pullRequestEvidence(
  generic: CertifiedGitHubSemanticReadEvidence,
  pullNumber: number,
  actual: GitHubPullRequestActualIdentity,
): CertifiedGitHubPullRequestEvidence {
  return {
    provider: generic.provider,
    api_version: generic.api_version,
    schema_sha256: generic.schema_sha256,
    schema_source_commit: generic.schema_source_commit,
    observer: { kind: 'git-kernel', id: 'github-pr-identity/v1' },
    repository_id: generic.repository_id,
    requested_repository_full_name: generic.requested_repository_full_name,
    repository: generic.repository,
    operation_id: 'pulls/get',
    observed_at: generic.observed_at,
    pull_number: pullNumber,
    pull_id: actual.id,
    node_id: actual.node_id,
    state: actual.state,
    head_sha: actual.head_sha,
    base_ref: actual.base_ref,
    base_sha: actual.base_sha,
    validated_paths: generic.validated_paths,
    optional_absent_paths: generic.optional_absent_paths,
  };
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
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) {
    throw new Error('GITHUB_PR_NUMBER_INVALID');
  }
  validateExpected(expected);

  try {
    const read = observeCertifiedGitHubSemanticRead(token, {
      repositoryId,
      repositoryFullName,
      operation: 'pull_request',
      parameters: { pull_number: pullNumber },
      grantedPermissions: ['pull_requests:read'],
      get,
      clock,
      observerId: 'github-pr-identity/v1',
    });
    if (read.state !== 'observed') {
      return {
        state: 'INDETERMINATE',
        reason: 'OBSERVATION_FAILED',
        pull_number: pullNumber,
        expected,
        observation_error:
          read.state === 'indeterminate'
            ? read.observation_error
            : 'GITHUB_PR_UNEXPECTED_COLLECTION_OBSERVATION',
      };
    }

    const evaluated = evaluateCertifiedGitHubPullRequestIdentity(read.value, pullNumber, expected);
    const evidence = pullRequestEvidence(read.evidence, pullNumber, evaluated.actual);
    return {
      state: evaluated.differences.length === 0 ? 'CURRENT' : 'STALE',
      reason:
        evaluated.differences.length === 0
          ? 'AUTHORITATIVE_PR_IDENTITY_MATCHES'
          : 'AUTHORITATIVE_PR_IDENTITY_DIFFERS',
      repository_full_name: read.evidence.repository.canonical_full_name,
      pull_number: pullNumber,
      expected,
      actual: evaluated.actual,
      differences: evaluated.differences,
      evidence,
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

export { GITHUB_PULL_REQUEST_OPERATION } from './operations.generated.ts';
export { GITHUB_PULL_REQUEST_RESPONSE_SLICE } from './semantics.ts';
