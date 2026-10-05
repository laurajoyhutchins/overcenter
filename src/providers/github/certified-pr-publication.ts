import {
  observeCertifiedGitHubSemanticRead,
  type CertifiedGitHubSemanticReadEvidence,
} from './certified-read.ts';
import { canonicalGitHubRef } from './certified-ref.ts';
import {
  githubGet,
  isGitHubObjectId,
  sameGitHubObjectId,
  type GitHubJsonGet,
} from './rest.ts';

interface PullRequestListMember {
  id: number;
  node_id: string;
  number: number;
  state: string;
  head: { sha: string };
  base: { ref: string; sha: string };
}

export interface CertifiedGitHubPullRequestPublicationEvidence {
  provider: 'github';
  observer: { kind: 'git-kernel'; id: 'github-pr-publication/v1' };
  repository_id: number;
  requested_repository_full_name: string;
  operation_id: 'pulls/list';
  observed_at: string;
  head_ref: string;
  head_sha: string;
  base_ref: string;
  base_sha: string;
  pull_number: number;
  node_id: string;
  source_read: CertifiedGitHubSemanticReadEvidence;
}

export type CertifiedGitHubPullRequestPublicationResult =
  | {
      state: 'CURRENT';
      reason: 'AUTHORITATIVE_PR_PUBLICATION_MATCHES';
      repository_full_name: string;
      pull_number: number;
      node_id: string;
      head_sha: string;
      base_sha: string;
      evidence: CertifiedGitHubPullRequestPublicationEvidence;
    }
  | {
      state: 'INDETERMINATE';
      reason:
        | 'PR_PUBLICATION_NOT_OBSERVED'
        | 'PR_PUBLICATION_OBSERVATION_AMBIGUOUS'
        | 'OBSERVATION_FAILED';
      observation_error?: string;
    };

function pullRequestMember(value: unknown): value is PullRequestListMember {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const pull = value as Record<string, unknown>;
  const head = pull.head;
  const base = pull.base;
  return (
    Number.isSafeInteger(pull.id) &&
    Number(pull.id) > 0 &&
    typeof pull.node_id === 'string' &&
    pull.node_id.length > 0 &&
    Number.isSafeInteger(pull.number) &&
    Number(pull.number) > 0 &&
    typeof pull.state === 'string' &&
    !!head &&
    typeof head === 'object' &&
    !Array.isArray(head) &&
    isGitHubObjectId((head as Record<string, unknown>).sha) &&
    !!base &&
    typeof base === 'object' &&
    !Array.isArray(base) &&
    typeof (base as Record<string, unknown>).ref === 'string' &&
    isGitHubObjectId((base as Record<string, unknown>).sha)
  );
}

export function observeCertifiedGitHubPullRequestPublication(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    headRef,
    expectedHeadSha,
    baseRef,
    expectedBaseSha,
    get = githubGet,
    clock = () => new Date().toISOString(),
  }: {
    repositoryId: number;
    repositoryFullName: string;
    headRef: string;
    expectedHeadSha: string;
    baseRef: string;
    expectedBaseSha: string;
    get?: GitHubJsonGet;
    clock?: () => string;
  },
): CertifiedGitHubPullRequestPublicationResult {
  const canonicalHeadRef = canonicalGitHubRef(headRef);
  if (!canonicalHeadRef.startsWith('refs/heads/')) {
    throw new Error('GITHUB_PR_PUBLICATION_HEAD_REF_INVALID');
  }
  if (!isGitHubObjectId(expectedHeadSha)) {
    throw new Error('GITHUB_PR_PUBLICATION_HEAD_SHA_INVALID');
  }
  if (!baseRef || baseRef.startsWith('refs/')) {
    throw new Error('GITHUB_PR_PUBLICATION_BASE_REF_INVALID');
  }
  if (!isGitHubObjectId(expectedBaseSha)) {
    throw new Error('GITHUB_PR_PUBLICATION_BASE_SHA_INVALID');
  }

  const [owner, repo, ...extra] = repositoryFullName.split('/');
  if (!owner || !repo || extra.length > 0) {
    throw new Error('GITHUB_PR_PUBLICATION_REPOSITORY_INVALID');
  }
  const branch = canonicalHeadRef.slice('refs/heads/'.length);
  const read = observeCertifiedGitHubSemanticRead(token, {
    repositoryId,
    repositoryFullName,
    operation: 'pull_requests',
    parameters: {
      base: baseRef,
      head: `${owner}:${branch}`,
      page: 1,
      per_page: 30,
      state: 'open',
    },
    grantedPermissions: ['pull_requests:read'],
    get,
    clock,
  });
  if (read.state === 'indeterminate') {
    return {
      state: 'INDETERMINATE',
      reason: 'OBSERVATION_FAILED',
      observation_error: read.observation_error,
    };
  }
  if (!Array.isArray(read.value)) {
    return {
      state: 'INDETERMINATE',
      reason: 'OBSERVATION_FAILED',
      observation_error: 'GITHUB_PR_PUBLICATION_COLLECTION_INVALID',
    };
  }

  const matches = read.value.filter(pullRequestMember).filter(
    (pull) =>
      pull.state === 'open' &&
      sameGitHubObjectId(pull.head.sha, expectedHeadSha) &&
      pull.base.ref === baseRef &&
      sameGitHubObjectId(pull.base.sha, expectedBaseSha),
  );
  if (matches.length === 0) {
    return { state: 'INDETERMINATE', reason: 'PR_PUBLICATION_NOT_OBSERVED' };
  }
  if (matches.length !== 1) {
    return { state: 'INDETERMINATE', reason: 'PR_PUBLICATION_OBSERVATION_AMBIGUOUS' };
  }

  const pull = matches[0]!;
  return {
    state: 'CURRENT',
    reason: 'AUTHORITATIVE_PR_PUBLICATION_MATCHES',
    repository_full_name: repositoryFullName,
    pull_number: pull.number,
    node_id: pull.node_id,
    head_sha: pull.head.sha,
    base_sha: pull.base.sha,
    evidence: {
      provider: 'github',
      observer: { kind: 'git-kernel', id: 'github-pr-publication/v1' },
      repository_id: repositoryId,
      requested_repository_full_name: repositoryFullName,
      operation_id: 'pulls/list',
      observed_at: read.evidence.observed_at,
      head_ref: canonicalHeadRef,
      head_sha: pull.head.sha,
      base_ref: pull.base.ref,
      base_sha: pull.base.sha,
      pull_number: pull.number,
      node_id: pull.node_id,
      source_read: read.evidence,
    },
  };
}
