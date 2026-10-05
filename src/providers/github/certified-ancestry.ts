import { observeGitHubSemanticSlice } from './certified-read.ts';
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
  const read = observeGitHubSemanticSlice(token, {
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
  const value = read.value as {
    status: 'ahead' | 'behind' | 'diverged' | 'identical';
    ahead_by: number;
    behind_by: number;
    base_commit: { sha: string };
    merge_base_commit: { sha: string };
  };
  if (
    !['ahead', 'behind', 'diverged', 'identical'].includes(value.status) ||
    !Number.isSafeInteger(value.ahead_by) ||
    value.ahead_by < 0 ||
    !Number.isSafeInteger(value.behind_by) ||
    value.behind_by < 0 ||
    !isGitHubObjectId(value.base_commit?.sha) ||
    !sameGitHubObjectId(value.base_commit.sha, ancestorSha) ||
    !isGitHubObjectId(value.merge_base_commit?.sha)
  ) {
    throw new Error('GITHUB_COMMIT_ANCESTRY_OBSERVATION_INVALID');
  }
  const relation =
    (value.status === 'ahead' || value.status === 'identical') &&
    value.behind_by === 0 &&
    sameGitHubObjectId(value.merge_base_commit.sha, ancestorSha)
      ? ('ancestor' as const)
      : ('not-ancestor' as const);
  return {
    state: relation,
    evidence: {
      provider: read.evidence.provider,
      api_version: read.evidence.api_version,
      schema_sha256: read.evidence.schema_sha256,
      schema_source_commit: read.evidence.schema_source_commit,
      observer: { kind: 'git-kernel', id: 'github-pull-request-branch-updated/v1' },
      operation_id: 'repos/compare-commits',
      observed_at: read.evidence.observed_at,
      requested_repository_full_name: repositoryFullName,
      request_path: read.evidence.request_path,
      ancestor_sha: ancestorSha,
      descendant_sha: descendantSha,
      status: value.status,
      ahead_by: value.ahead_by,
      behind_by: value.behind_by,
      merge_base_sha: value.merge_base_commit.sha,
      relation,
      validated_paths: read.evidence.validated_paths,
      optional_absent_paths: read.evidence.optional_absent_paths,
    },
  };
}
