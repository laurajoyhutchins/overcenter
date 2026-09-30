import { sha256 } from '../../digest.ts';
import {
  observeCertifiedGitHubSemanticRead,
  type CertifiedGitHubSemanticReadEvidence,
} from './certified-read.ts';
import { type GitHubJsonGet, githubGet } from './rest.ts';

export const GITHUB_ISSUE_COMMENT_ATTESTATION_POLICY =
  'github-issue-comment-attestation/v1' as const;

export interface GitHubIssueCommentAttestation {
  repository_id: number;
  repository_full_name: string;
  issue_number: number;
  comment_id: number;
  comment_node_id: string;
  author_login: string;
  body_sha256: string;
  acceptance_policy: typeof GITHUB_ISSUE_COMMENT_ATTESTATION_POLICY;
}

export interface CertifiedGitHubIssueCommentAttestationEvidence {
  pages: CertifiedGitHubSemanticReadEvidence[];
  comment_id: number;
  comment_node_id: string;
  author_login: string;
  body_sha256: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubIssueCommentAttestationResult {
  state: 'CURRENT' | 'STALE' | 'INDETERMINATE';
  reason:
    | 'AUTHORITATIVE_JUDGMENT_ATTESTATION_MATCHES'
    | 'AUTHORITATIVE_JUDGMENT_ATTESTATION_DIFFERS'
    | 'AUTHORITATIVE_JUDGMENT_ATTESTATION_NOT_FOUND'
    | 'OBSERVATION_FAILED';
  expected: GitHubIssueCommentAttestation;
  actual?: {
    comment_node_id: string;
    author_login: string;
    body_sha256: string;
    created_at: string;
    updated_at: string;
  };
  differences?: string[];
  evidence?: CertifiedGitHubIssueCommentAttestationEvidence;
  observation_error?: string;
}

function validateExpected(expected: GitHubIssueCommentAttestation): void {
  if (!Number.isSafeInteger(expected.repository_id) || expected.repository_id <= 0) {
    throw new Error('GITHUB_JUDGMENT_ATTESTATION_REPOSITORY_ID_INVALID');
  }
  if (!/^[^/]+\/[^/]+$/.test(expected.repository_full_name)) {
    throw new Error('GITHUB_JUDGMENT_ATTESTATION_REPOSITORY_INVALID');
  }
  if (!Number.isSafeInteger(expected.issue_number) || expected.issue_number <= 0) {
    throw new Error('GITHUB_JUDGMENT_ATTESTATION_ISSUE_NUMBER_INVALID');
  }
  if (!Number.isSafeInteger(expected.comment_id) || expected.comment_id <= 0) {
    throw new Error('GITHUB_JUDGMENT_ATTESTATION_COMMENT_ID_INVALID');
  }
  if (!expected.comment_node_id) {
    throw new Error('GITHUB_JUDGMENT_ATTESTATION_COMMENT_NODE_ID_REQUIRED');
  }
  if (!expected.author_login) {
    throw new Error('GITHUB_JUDGMENT_ATTESTATION_AUTHOR_REQUIRED');
  }
  if (!/^[0-9a-f]{64}$/i.test(expected.body_sha256)) {
    throw new Error('GITHUB_JUDGMENT_ATTESTATION_BODY_DIGEST_INVALID');
  }
  if (expected.acceptance_policy !== GITHUB_ISSUE_COMMENT_ATTESTATION_POLICY) {
    throw new Error('GITHUB_JUDGMENT_ATTESTATION_POLICY_UNSUPPORTED');
  }
}

export function observeCertifiedGitHubIssueCommentAttestation(
  token: string,
  expected: GitHubIssueCommentAttestation,
  {
    get = githubGet,
    clock = () => new Date().toISOString(),
    maxPages = 1000,
  }: {
    get?: GitHubJsonGet;
    clock?: () => string;
    maxPages?: number;
  } = {},
): GitHubIssueCommentAttestationResult {
  validateExpected(expected);
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) {
    throw new Error('GITHUB_JUDGMENT_ATTESTATION_PAGE_LIMIT_INVALID');
  }

  const pages: CertifiedGitHubSemanticReadEvidence[] = [];
  const pageSize = 30;
  for (let page = 1; page <= maxPages; page += 1) {
    const observed = observeCertifiedGitHubSemanticRead(token, {
      repositoryId: expected.repository_id,
      repositoryFullName: expected.repository_full_name,
      operation: 'issue_comments',
      parameters: {
        issue_number: expected.issue_number,
        page,
        per_page: pageSize,
      },
      grantedPermissions: ['issues:read'],
      get,
      clock,
    });
    if (observed.state === 'indeterminate') {
      return {
        state: 'INDETERMINATE',
        reason: 'OBSERVATION_FAILED',
        expected,
        observation_error: observed.observation_error,
      };
    }
    if (!Array.isArray(observed.value)) {
      return {
        state: 'INDETERMINATE',
        reason: 'OBSERVATION_FAILED',
        expected,
        observation_error: 'GITHUB_JUDGMENT_ATTESTATION_COMMENT_COLLECTION_INVALID',
      };
    }

    pages.push(observed.evidence);
    const matching = observed.value.find(
      (member) =>
        member !== null &&
        typeof member === 'object' &&
        !Array.isArray(member) &&
        (member as Record<string, unknown>).id === expected.comment_id,
    ) as Record<string, unknown> | undefined;

    if (matching) {
      const user =
        matching.user !== null && typeof matching.user === 'object' && !Array.isArray(matching.user)
          ? (matching.user as Record<string, unknown>)
          : null;
      if (
        typeof matching.node_id !== 'string' ||
        typeof user?.login !== 'string' ||
        typeof matching.body !== 'string' ||
        typeof matching.created_at !== 'string' ||
        typeof matching.updated_at !== 'string'
      ) {
        return {
          state: 'INDETERMINATE',
          reason: 'OBSERVATION_FAILED',
          expected,
          observation_error: 'GITHUB_JUDGMENT_ATTESTATION_COMMENT_FIELDS_UNAVAILABLE',
        };
      }

      const actual = {
        comment_node_id: matching.node_id,
        author_login: user.login,
        body_sha256: sha256(matching.body),
        created_at: matching.created_at,
        updated_at: matching.updated_at,
      };
      const differences: string[] = [];
      if (actual.comment_node_id !== expected.comment_node_id) differences.push('comment_node_id');
      if (actual.author_login.toLowerCase() !== expected.author_login.toLowerCase()) {
        differences.push('author_login');
      }
      if (actual.body_sha256.toLowerCase() !== expected.body_sha256.toLowerCase()) {
        differences.push('body_sha256');
      }

      return {
        state: differences.length === 0 ? 'CURRENT' : 'STALE',
        reason:
          differences.length === 0
            ? 'AUTHORITATIVE_JUDGMENT_ATTESTATION_MATCHES'
            : 'AUTHORITATIVE_JUDGMENT_ATTESTATION_DIFFERS',
        expected,
        actual,
        differences,
        evidence: {
          pages,
          comment_id: expected.comment_id,
          comment_node_id: actual.comment_node_id,
          author_login: actual.author_login,
          body_sha256: actual.body_sha256,
          created_at: actual.created_at,
          updated_at: actual.updated_at,
        },
      };
    }

    if (observed.value.length < pageSize) {
      return {
        state: 'STALE',
        reason: 'AUTHORITATIVE_JUDGMENT_ATTESTATION_NOT_FOUND',
        expected,
        differences: ['comment_id'],
      };
    }
  }

  return {
    state: 'INDETERMINATE',
    reason: 'OBSERVATION_FAILED',
    expected,
    observation_error: 'GITHUB_JUDGMENT_ATTESTATION_PAGE_LIMIT_REACHED',
  };
}
