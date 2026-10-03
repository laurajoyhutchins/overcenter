import {
  evaluateCertifiedGitHubPullRequestIdentity,
  type GitHubPullRequestExpectedIdentity,
} from './certified-predicates.ts';
import {
  observeCertifiedGitHubSemanticRead,
  type CertifiedGitHubSemanticReadEvidence,
} from './semantic-read.ts';
import type { GitHubJsonGet } from './rest.ts';

export type { GitHubPullRequestExpectedIdentity } from './certified-predicates.ts';

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
  actual?: GitHubPullRequestExpectedIdentity & { id: number };
  differences?: string[];
  evidence?: CertifiedGitHubPullRequestEvidence;
  observation_error?: string;
}

export function observeCertifiedGitHubPullRequestIdentity(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    pullNumber,
    expected,
    get,
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
  const read = observeCertifiedGitHubSemanticRead(token, {
    repositoryId,
    repositoryFullName,
    operation: 'pull_request',
    parameters: { pull_number: pullNumber },
    grantedPermissions: ['pull_requests:read'],
    ...(get ? { get } : {}),
    clock,
  });
  if (read.state === 'indeterminate') {
    return {
      state: 'INDETERMINATE',
      reason: 'OBSERVATION_FAILED',
      pull_number: pullNumber,
      expected,
      observation_error: read.observation_error,
    };
  }
  if (read.state !== 'observed') {
    return {
      state: 'INDETERMINATE',
      reason: 'OBSERVATION_FAILED',
      pull_number: pullNumber,
      expected,
      observation_error: 'GITHUB_PR_UNEXPECTED_COLLECTION_OBSERVATION',
    };
  }

  try {
    const evaluated = evaluateCertifiedGitHubPullRequestIdentity(read.value, pullNumber, expected);
    const evidence: CertifiedGitHubPullRequestEvidence = {
      provider: read.evidence.provider,
      api_version: read.evidence.api_version,
      schema_sha256: read.evidence.schema_sha256,
      schema_source_commit: read.evidence.schema_source_commit,
      observer: { kind: 'git-kernel', id: 'github-pr-identity/v1' },
      repository_id: repositoryId,
      requested_repository_full_name: repositoryFullName,
      repository: read.evidence.repository,
      operation_id: 'pulls/get',
      observed_at: read.evidence.observed_at,
      pull_number: pullNumber,
      pull_id: evaluated.actual.id,
      node_id: evaluated.actual.node_id,
      state: evaluated.actual.state,
      head_sha: evaluated.actual.head_sha,
      base_ref: evaluated.actual.base_ref,
      base_sha: evaluated.actual.base_sha,
      validated_paths: read.evidence.validated_paths,
      optional_absent_paths: read.evidence.optional_absent_paths,
    };

    return {
      state: evaluated.differences.length === 0 ? 'CURRENT' : 'STALE',
      reason:
        evaluated.differences.length === 0
          ? 'AUTHORITATIVE_PR_IDENTITY_MATCHES'
          : 'AUTHORITATIVE_PR_IDENTITY_DIFFERS',
      repository_full_name: read.evidence.repository.fact.object.full_name,
      pull_number: pullNumber,
      expected,
      actual: evaluated.actual,
      differences: evaluated.differences,
      evidence,
    };
  } catch (error: unknown) {
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
