import {
  observeCertifiedGitHubRead,
  type CertifiedGitHubReadEvidence,
} from './certified-read.ts';
import { isGitHubObjectId, sameGitHubObjectId, type GitHubJsonGet } from './rest.ts';

export interface CertifiedGitHubCommitAncestryEvidence {
  provider: 'github';
  api_version: string;
  schema_sha256: string;
  schema_source_commit: string;
  observer: { kind: 'git-kernel'; id: 'github-pull-request-branch-updated/v1' };
  operation_id: 'repos/compare-commits';
  observed_at: string;
  requested_repository_full_name: string;
  request_path: string;
  ancestor_sha: string;
  descendant_sha: string;
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  ahead_by: number;
  behind_by: number;
  merge_base_sha: string;
  relation: 'ancestor' | 'not-ancestor';
  validated_paths: string[];
  optional_absent_paths: string[];
}

export interface CertifiedGitHubCommitAncestryResult {
  state: 'ancestor' | 'not-ancestor';
  evidence: CertifiedGitHubCommitAncestryEvidence;
}

export interface GitHubCommitAncestryPredicateResult {
  status: 'ahead' | 'behind' | 'diverged' | 'identical';
  ahead_by: number;
  behind_by: number;
  merge_base_sha: string;
  relation: 'ancestor' | 'not-ancestor';
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

function ancestryEvidence(
  generic: CertifiedGitHubReadEvidence,
  ancestorSha: string,
  descendantSha: string,
  evaluated: GitHubCommitAncestryPredicateResult,
): CertifiedGitHubCommitAncestryEvidence {
  return {
    provider: generic.provider,
    api_version: generic.api_version,
    schema_sha256: generic.schema_sha256,
    schema_source_commit: generic.schema_source_commit,
    observer: { kind: 'git-kernel', id: 'github-pull-request-branch-updated/v1' },
    operation_id: 'repos/compare-commits',
    observed_at: generic.observed_at,
    requested_repository_full_name: generic.requested_repository_full_name,
    request_path: generic.request_path,
    ancestor_sha: ancestorSha,
    descendant_sha: descendantSha,
    status: evaluated.status,
    ahead_by: evaluated.ahead_by,
    behind_by: evaluated.behind_by,
    merge_base_sha: evaluated.merge_base_sha,
    relation: evaluated.relation,
    validated_paths: generic.validated_paths,
    optional_absent_paths: generic.optional_absent_paths,
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
  if (read.state !== 'observed') {
    throw new Error('GITHUB_COMMIT_ANCESTRY_UNEXPECTED_COLLECTION_OBSERVATION');
  }
  const evaluated = evaluateCertifiedGitHubCommitAncestry(read.value, ancestorSha);
  return {
    state: evaluated.relation,
    evidence: ancestryEvidence(read.evidence, ancestorSha, descendantSha, evaluated),
  };
}

export { GITHUB_COMPARE_COMMITS_OPERATION } from './operations.generated.ts';
export { GITHUB_COMPARE_COMMITS_RESPONSE_SLICE } from './semantics.ts';
