import { observeGitHubSemanticSlice } from './certified-read.ts';
import {
  observeCertifiedGitHubRepository,
  type CertifiedGitHubRepositoryEvidence,
} from './certified-repository.ts';
import { GitHubAsyncReadRequired, githubGet, isGitHubObjectId, sameGitHubObjectId, type GitHubJsonGet } from './rest.ts';

export interface CertifiedGitHubRefEvidence {
  provider: 'github';
  api_version: string;
  schema_sha256: string;
  schema_source_commit: string;
  observer: { kind: 'git-kernel'; id: 'github-ref-fence/v1' };
  repository_id: number;
  requested_repository_full_name: string;
  repository: CertifiedGitHubRepositoryEvidence;
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

export function canonicalGitHubRef(ref: string): string {
  if (ref.startsWith('refs/heads/') || ref.startsWith('refs/tags/')) return ref;
  if (ref.startsWith('heads/') || ref.startsWith('tags/')) return `refs/${ref}`;
  throw new Error('GITHUB_REF_COORDINATE_INVALID');
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
    const repository = observeCertifiedGitHubRepository(token, {
      repositoryId,
      repositoryFullName,
      get,
      clock,
      observerId: 'github-ref-fence/v1',
    });
    const read = observeGitHubSemanticSlice(token, {
      repositoryFullName: repository.fact.object.full_name,
      operation: 'ref',
      parameters: { ref: requestedRef },
      get,
      clock,
      observerId: 'github-ref-fence/v1',
    });
    if (read.state !== 'observed') throw new Error('GITHUB_REF_UNEXPECTED_COLLECTION_OBSERVATION');
    const value = read.value as { ref: string; object: { type: string; sha: string } };
    if (!['commit', 'tag'].includes(value.object.type))
      throw new Error('GITHUB_REF_OBJECT_TYPE_INVALID');
    if (!isGitHubObjectId(value.object.sha)) throw new Error('GITHUB_REF_OBJECT_SHA_INVALID');
    if (canonicalGitHubRef(value.ref) !== canonicalRef) {
      throw new Error('GITHUB_REF_RESPONSE_COORDINATE_MISMATCH');
    }
    const evidence: CertifiedGitHubRefEvidence = {
      provider: read.evidence.provider,
      api_version: read.evidence.api_version,
      schema_sha256: read.evidence.schema_sha256,
      schema_source_commit: read.evidence.schema_source_commit,
      observer: { kind: 'git-kernel', id: 'github-ref-fence/v1' },
      repository_id: repositoryId,
      requested_repository_full_name: repositoryFullName,
      repository: repository.evidence,
      operation_id: 'git/get-ref',
      observed_at: read.evidence.observed_at,
      requested_ref: requestedRef,
      canonical_ref: canonicalRef,
      object_kind: value.object.type === 'commit' ? 'github.commit' : 'github.tag',
      actual_sha: value.object.sha,
      validated_paths: read.evidence.validated_paths,
      optional_absent_paths: read.evidence.optional_absent_paths,
    };
    const current = sameGitHubObjectId(value.object.sha, expectedSha);
    return {
      state: current ? 'CURRENT' : 'STALE',
      reason: current ? 'AUTHORITATIVE_BINDING_MATCHES' : 'AUTHORITATIVE_BINDING_DIFFERS',
      repository_full_name: repository.fact.object.full_name,
      ref: canonicalRef,
      expected_sha: expectedSha,
      actual_sha: value.object.sha,
      evidence,
    };
  } catch (error: unknown) {
    if (error instanceof GitHubAsyncReadRequired) throw error;
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
