import { evaluateCertifiedGitHubRef, canonicalGitHubRef } from './certified-predicates.ts';
import {
  observeCertifiedGitHubSemanticRead,
  type CertifiedGitHubSemanticReadEvidence,
} from './semantic-read.ts';
import { isGitHubObjectId, type GitHubJsonGet } from './rest.ts';

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

function apiRef(ref: string): string {
  return canonicalGitHubRef(ref).slice('refs/'.length);
}

export function observeCertifiedGitHubRefFence(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    ref,
    expectedSha,
    get,
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

  const read = observeCertifiedGitHubSemanticRead(token, {
    repositoryId,
    repositoryFullName,
    operation: 'ref',
    parameters: { ref: requestedRef },
    grantedPermissions: ['contents:read'],
    ...(get ? { get } : {}),
    clock,
  });
  if (read.state === 'indeterminate') {
    return {
      state: 'INDETERMINATE',
      reason: 'OBSERVATION_FAILED',
      ref: canonicalRef,
      expected_sha: expectedSha,
      observation_error: read.observation_error,
    };
  }
  if (read.state !== 'observed') {
    return {
      state: 'INDETERMINATE',
      reason: 'OBSERVATION_FAILED',
      ref: canonicalRef,
      expected_sha: expectedSha,
      observation_error: 'GITHUB_REF_UNEXPECTED_COLLECTION_OBSERVATION',
    };
  }

  try {
    const evaluated = evaluateCertifiedGitHubRef(read.value, canonicalRef, expectedSha);
    const evidence: CertifiedGitHubRefEvidence = {
      provider: read.evidence.provider,
      api_version: read.evidence.api_version,
      schema_sha256: read.evidence.schema_sha256,
      schema_source_commit: read.evidence.schema_source_commit,
      observer: { kind: 'git-kernel', id: 'github-ref-fence/v1' },
      repository_id: repositoryId,
      requested_repository_full_name: repositoryFullName,
      repository: read.evidence.repository,
      operation_id: 'git/get-ref',
      observed_at: read.evidence.observed_at,
      requested_ref: requestedRef,
      canonical_ref: canonicalRef,
      object_kind: evaluated.object_kind,
      actual_sha: evaluated.actual_sha,
      validated_paths: read.evidence.validated_paths,
      optional_absent_paths: read.evidence.optional_absent_paths,
    };
    return {
      state: evaluated.current ? 'CURRENT' : 'STALE',
      reason: evaluated.current ? 'AUTHORITATIVE_BINDING_MATCHES' : 'AUTHORITATIVE_BINDING_DIFFERS',
      repository_full_name: read.evidence.repository.fact.object.full_name,
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

export { canonicalGitHubRef } from './certified-predicates.ts';
export { GITHUB_REF_OPERATION } from './operations.generated.ts';
export { GITHUB_REF_RESPONSE_SLICE } from './semantics.ts';
