import {
  observeCertifiedGitHubSemanticRead,
  type CertifiedGitHubSemanticReadEvidence,
} from './certified-read.ts';
import { githubGet, isGitHubObjectId, sameGitHubObjectId, type GitHubJsonGet } from './rest.ts';

export interface CertifiedGitHubRefEvidence {
  provider: 'github';
  api_version: string;
  schema_sha256: string;
  schema_source_commit: string;
  observer: { kind: 'git-kernel'; id: 'github-ref-fence/v1' };
  repository_id: number;
  requested_repository_full_name: string;
  repository: CertifiedGitHubSemanticReadEvidence['repository'];
  operation_id: 'git/get-ref';
  observed_at: string;
  requested_ref: string;
  canonical_ref: string;
  object_kind: 'github.commit' | 'github.tag';
  actual_sha: string;
  validated_paths: string[];
  optional_absent_paths: string[];
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

export interface GitHubRefPredicateResult {
  current: boolean;
  actual_sha: string;
  object_kind: 'github.commit' | 'github.tag';
}

export function canonicalGitHubRef(ref: string): string {
  if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) return ref;
  if (ref.startsWith('heads/') || ref.startsWith('tags/')) return `refs/${ref}`;
  throw new Error('GITHUB_REF_COORDINATE_INVALID');
}

function apiRef(ref: string): string {
  return canonicalGitHubRef(ref).slice('refs/'.length);
}

export function evaluateCertifiedGitHubRef(
  value: unknown,
  canonicalRef: string,
  expectedSha: string,
): GitHubRefPredicateResult {
  const observed = value as {
    ref: string;
    object: { type: string; sha: string };
  };
  if (!['commit', 'tag'].includes(observed.object.type)) {
    throw new Error('GITHUB_REF_OBJECT_TYPE_INVALID');
  }
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

function refEvidence(
  generic: CertifiedGitHubSemanticReadEvidence,
  {
    requestedRef,
    canonicalRef,
    evaluated,
  }: {
    requestedRef: string;
    canonicalRef: string;
    evaluated: GitHubRefPredicateResult;
  },
): CertifiedGitHubRefEvidence {
  return {
    provider: generic.provider,
    api_version: generic.api_version,
    schema_sha256: generic.schema_sha256,
    schema_source_commit: generic.schema_source_commit,
    observer: { kind: 'git-kernel', id: 'github-ref-fence/v1' },
    repository_id: generic.repository_id,
    requested_repository_full_name: generic.requested_repository_full_name,
    repository: generic.repository,
    operation_id: 'git/get-ref',
    observed_at: generic.observed_at,
    requested_ref: requestedRef,
    canonical_ref: canonicalRef,
    object_kind: evaluated.object_kind,
    actual_sha: evaluated.actual_sha,
    validated_paths: generic.validated_paths,
    optional_absent_paths: generic.optional_absent_paths,
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
  const requestedRef = apiRef(canonicalRef);

  try {
    const read = observeCertifiedGitHubSemanticRead(token, {
      repositoryId,
      repositoryFullName,
      operation: 'ref',
      parameters: { ref: requestedRef },
      grantedPermissions: ['contents:read'],
      get,
      clock,
      observerId: 'github-ref-fence/v1',
    });
    if (read.state !== 'observed') {
      return {
        state: 'INDETERMINATE',
        reason: 'OBSERVATION_FAILED',
        ref: canonicalRef,
        expected_sha: expectedSha,
        observation_error:
          read.state === 'indeterminate'
            ? read.observation_error
            : 'GITHUB_REF_UNEXPECTED_COLLECTION_OBSERVATION',
      };
    }

    const evaluated = evaluateCertifiedGitHubRef(read.value, canonicalRef, expectedSha);
    const evidence = refEvidence(read.evidence, { requestedRef, canonicalRef, evaluated });
    return {
      state: evaluated.current ? 'CURRENT' : 'STALE',
      reason: evaluated.current ? 'AUTHORITATIVE_BINDING_MATCHES' : 'AUTHORITATIVE_BINDING_DIFFERS',
      repository_full_name: read.evidence.repository.canonical_full_name,
      ref: canonicalRef,
      expected_sha: expectedSha,
      actual_sha: evaluated.actual_sha,
      evidence,
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

export { GITHUB_REF_OPERATION } from './operations.generated.ts';
export { GITHUB_REF_RESPONSE_SLICE } from './semantics.ts';
