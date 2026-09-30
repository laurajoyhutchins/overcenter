import type { ResponseFieldSpec } from '../../observation/response-slice.ts';
import { observeCertifiedGitHubRead200 } from './certified-observation.ts';
import {
  observeCertifiedGitHubRepository,
  type CertifiedGitHubRepositoryEvidence,
} from './certified-repository.ts';
import { GITHUB_PULL_REQUEST_OPERATION } from './operations.generated.ts';
import { materializeGitHubOperationRequest } from './openapi.ts';
import { githubGet, isGitHubObjectId, sameGitHubObjectId, type GitHubJsonGet } from './rest.ts';

export const GITHUB_PR_REVIEW_ATTESTATION_POLICY = 'github-pr-merge-by-reviewer/v1' as const;

const REVIEW_ATTESTATION_FIELDS = [
  { path: 'id' },
  { path: 'node_id' },
  { path: 'number' },
  { path: 'state' },
  { path: 'head.sha' },
  { path: 'base.ref' },
  { path: 'base.sha' },
  { path: 'merge_commit_sha' },
  { path: 'merged_at' },
  { path: 'merged_by' },
] as const satisfies readonly ResponseFieldSpec[];

export interface GitHubPullRequestReviewAttestation {
  repository_id: number;
  repository_full_name: string;
  pull_number: number;
  pull_node_id: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
  reviewer_login: string;
  acceptance_policy: typeof GITHUB_PR_REVIEW_ATTESTATION_POLICY;
}

export interface CertifiedGitHubPullRequestReviewEvidence {
  repository: CertifiedGitHubRepositoryEvidence;
  operation_id: 'pulls/get';
  observed_at: string;
  pull_id: number;
  pull_node_id: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
  merge_commit_sha: string | null;
  merged_at: string | null;
  reviewer_login: string | null;
  validated_paths: string[];
  optional_absent_paths: string[];
}

export interface GitHubPullRequestReviewAttestationResult {
  state: 'CURRENT' | 'STALE' | 'INDETERMINATE';
  reason:
    | 'AUTHORITATIVE_REVIEW_ATTESTATION_MATCHES'
    | 'AUTHORITATIVE_REVIEW_ATTESTATION_DIFFERS'
    | 'OBSERVATION_FAILED';
  expected: GitHubPullRequestReviewAttestation;
  actual?: {
    pull_node_id: string;
    head_sha: string;
    base_ref: string;
    base_sha: string;
    reviewer_login: string | null;
    merge_commit_sha: string | null;
  };
  differences?: string[];
  evidence?: CertifiedGitHubPullRequestReviewEvidence;
  observation_error?: string;
}

function validateExpected(expected: GitHubPullRequestReviewAttestation): void {
  if (!Number.isSafeInteger(expected.repository_id) || expected.repository_id <= 0) {
    throw new Error('GITHUB_REVIEW_ATTESTATION_REPOSITORY_ID_INVALID');
  }
  if (!/^[^/]+\/[^/]+$/.test(expected.repository_full_name)) {
    throw new Error('GITHUB_REVIEW_ATTESTATION_REPOSITORY_INVALID');
  }
  if (!Number.isSafeInteger(expected.pull_number) || expected.pull_number <= 0) {
    throw new Error('GITHUB_REVIEW_ATTESTATION_PULL_NUMBER_INVALID');
  }
  if (!expected.pull_node_id) throw new Error('GITHUB_REVIEW_ATTESTATION_PULL_NODE_ID_REQUIRED');
  if (!isGitHubObjectId(expected.head_sha)) {
    throw new Error('GITHUB_REVIEW_ATTESTATION_HEAD_INVALID');
  }
  if (!expected.base_ref || !isGitHubObjectId(expected.base_sha)) {
    throw new Error('GITHUB_REVIEW_ATTESTATION_BASE_INVALID');
  }
  if (!expected.reviewer_login) throw new Error('GITHUB_REVIEW_ATTESTATION_REVIEWER_REQUIRED');
  if (expected.acceptance_policy !== GITHUB_PR_REVIEW_ATTESTATION_POLICY) {
    throw new Error('GITHUB_REVIEW_ATTESTATION_POLICY_UNSUPPORTED');
  }
}

export function observeCertifiedGitHubPullRequestReviewAttestation(
  token: string,
  expected: GitHubPullRequestReviewAttestation,
  {
    get = githubGet,
    clock = () => new Date().toISOString(),
  }: {
    get?: GitHubJsonGet;
    clock?: () => string;
  } = {},
): GitHubPullRequestReviewAttestationResult {
  validateExpected(expected);

  try {
    const repository = observeCertifiedGitHubRepository(token, {
      repositoryId: expected.repository_id,
      repositoryFullName: expected.repository_full_name,
      get,
      clock,
      observerId: 'github-pr-review-attestation/v1',
    });
    const request = materializeGitHubOperationRequest(GITHUB_PULL_REQUEST_OPERATION, {
      owner: repository.fact.object.owner,
      repo: repository.fact.object.repo,
      pull_number: expected.pull_number,
    });
    const { observed_at: observedAt, certified } = observeCertifiedGitHubRead200({
      token,
      operation: GITHUB_PULL_REQUEST_OPERATION,
      request,
      fields: REVIEW_ATTESTATION_FIELDS,
      get,
      clock,
      observerId: 'github-pr-review-attestation/v1',
    });
    const value = certified.outcome.value as {
      id: number;
      node_id: string;
      number: number;
      state: string;
      head: { sha: string };
      base: { ref: string; sha: string };
      merge_commit_sha: string | null;
      merged_at: string | null;
      merged_by: { login: string } | null;
    };

    if (
      !Number.isSafeInteger(value.id) ||
      value.id <= 0 ||
      value.number !== expected.pull_number ||
      !value.node_id ||
      !isGitHubObjectId(value.head.sha) ||
      !value.base.ref ||
      !isGitHubObjectId(value.base.sha)
    ) {
      throw new Error('GITHUB_REVIEW_ATTESTATION_IDENTITY_INVALID');
    }
    const unmerged =
      value.merge_commit_sha === null && value.merged_at === null && value.merged_by === null;
    const merged =
      typeof value.merge_commit_sha === 'string' &&
      isGitHubObjectId(value.merge_commit_sha) &&
      typeof value.merged_at === 'string' &&
      value.merged_at.length > 0 &&
      typeof value.merged_by?.login === 'string' &&
      value.merged_by.login.length > 0;
    if (!unmerged && !merged) {
      throw new Error('GITHUB_REVIEW_ATTESTATION_MERGE_PROVENANCE_INVALID');
    }

    const actual = {
      pull_node_id: value.node_id,
      head_sha: value.head.sha,
      base_ref: value.base.ref,
      base_sha: value.base.sha,
      reviewer_login: value.merged_by?.login ?? null,
      merge_commit_sha: value.merge_commit_sha,
    };
    const differences: string[] = [];
    if (value.state !== 'closed') differences.push('state');
    if (!merged) differences.push('merged');
    if (actual.pull_node_id !== expected.pull_node_id) differences.push('pull_node_id');
    if (!sameGitHubObjectId(actual.head_sha, expected.head_sha)) differences.push('head_sha');
    if (actual.base_ref !== expected.base_ref) differences.push('base_ref');
    if (!sameGitHubObjectId(actual.base_sha, expected.base_sha)) differences.push('base_sha');
    if (
      actual.reviewer_login !== null &&
      actual.reviewer_login.toLowerCase() !== expected.reviewer_login.toLowerCase()
    ) {
      differences.push('reviewer_login');
    }

    const evidence: CertifiedGitHubPullRequestReviewEvidence = {
      repository: repository.evidence,
      operation_id: 'pulls/get',
      observed_at: observedAt,
      pull_id: value.id,
      pull_node_id: value.node_id,
      head_sha: value.head.sha,
      base_ref: value.base.ref,
      base_sha: value.base.sha,
      merge_commit_sha: value.merge_commit_sha,
      merged_at: value.merged_at,
      reviewer_login: value.merged_by?.login ?? null,
      validated_paths: certified.structural_validation.validated_paths,
      optional_absent_paths: certified.structural_validation.optional_absent_paths,
    };

    return {
      state: differences.length === 0 ? 'CURRENT' : 'STALE',
      reason:
        differences.length === 0
          ? 'AUTHORITATIVE_REVIEW_ATTESTATION_MATCHES'
          : 'AUTHORITATIVE_REVIEW_ATTESTATION_DIFFERS',
      expected,
      actual,
      differences,
      evidence,
    };
  } catch (error: unknown) {
    return {
      state: 'INDETERMINATE',
      reason: 'OBSERVATION_FAILED',
      expected,
      observation_error: error instanceof Error ? error.message : String(error),
    };
  }
}
