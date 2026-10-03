import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './contract.ts';
import { GITHUB_OBSERVATION_OPERATIONS } from './operations.generated.ts';
import { materializeGitHubOperationRequest } from './openapi.ts';
import {
  GITHUB_OPERATION_SEMANTICS,
  type GitHubRepositoryReadPermission,
  type GitHubSemanticOperationName,
} from './semantics.ts';
import { githubRepositoryCoordinate } from './certified-repository.ts';
import { projectResponseSlice } from '../../observation/response-slice.ts';
import { observeCertifiedGitHubRead200 } from './certified-observation.ts';
import { githubGet, type GitHubJsonGet } from './rest.ts';

export type GitHubGenericSemanticOperationName = Exclude<GitHubSemanticOperationName, 'repository'>;

export interface CertifiedGitHubReadEvidence {
  provider: 'github';
  api_version: string;
  schema_sha256: string;
  schema_source_commit: string;
  observer: { kind: 'git-kernel'; id: string };
  requested_repository_full_name: string;
  operation_key: GitHubGenericSemanticOperationName;
  operation_id: string;
  observed_at: string;
  request_path: string;
  parameters: Record<string, string | number | boolean>;
  required_permissions: readonly GitHubRepositoryReadPermission[];
  collection: null | {
    kind: 'single-page';
    page: number;
    page_size: number;
    completeness: 'page-only';
  };
  negative_evidence_authoritative: false;
  validated_paths: string[];
  optional_absent_paths: string[];
}

export interface CertifiedGitHubReadResult {
  state: 'observed' | 'page-observed';
  value: unknown;
  evidence: CertifiedGitHubReadEvidence;
}

export function observeCertifiedGitHubRead(
  token: string,
  {
    repositoryFullName,
    operation: operationName,
    parameters = {},
    get = githubGet,
    clock = () => new Date().toISOString(),
    observerId = 'github-semantic-read/v1',
  }: {
    repositoryFullName: string;
    operation: GitHubGenericSemanticOperationName;
    parameters?: Record<string, string | number | boolean>;
    get?: GitHubJsonGet;
    clock?: () => string;
    observerId?: string;
  },
): CertifiedGitHubReadResult {
  const { owner, repo } = githubRepositoryCoordinate(repositoryFullName);
  const operation = GITHUB_OBSERVATION_OPERATIONS[operationName];
  const semantic = GITHUB_OPERATION_SEMANTICS[operationName];
  const requestValues: Record<string, string | number | boolean> = { owner, repo };
  for (const name in parameters) {
    if (!Object.hasOwn(parameters, name) || name === 'owner' || name === 'repo') continue;
    requestValues[name] = parameters[name]!;
  }
  const request = materializeGitHubOperationRequest(operation, requestValues);
  const { observed_at: observedAt, certified } = observeCertifiedGitHubRead200({
    token,
    operation,
    request,
    fields: semantic.response_slice,
    get,
    clock,
    observerId,
  });
  const value = projectResponseSlice(certified.outcome.value, semantic.response_slice);
  const collection = operation.pagination
    ? {
        kind: 'single-page' as const,
        page: Number(
          request.parameters[operation.pagination.page_parameter] ??
            operation.pagination.first_page,
        ),
        page_size: Number(
          request.parameters[operation.pagination.page_size_parameter] ??
            operation.pagination.default_page_size,
        ),
        completeness: 'page-only' as const,
      }
    : null;

  return {
    state: collection ? 'page-observed' : 'observed',
    value,
    evidence: {
      provider: 'github',
      api_version: GITHUB_API_VERSION,
      schema_sha256: GITHUB_OPENAPI_SHA256,
      schema_source_commit: GITHUB_OPENAPI_SOURCE_COMMIT,
      observer: { kind: 'git-kernel', id: observerId },
      requested_repository_full_name: repositoryFullName,
      operation_key: operationName,
      operation_id: operation.operation_id,
      observed_at: observedAt,
      request_path: request.path,
      parameters: request.parameters,
      required_permissions: semantic.required_permissions,
      collection,
      negative_evidence_authoritative: false,
      validated_paths: certified.structural_validation.validated_paths,
      optional_absent_paths: certified.structural_validation.optional_absent_paths,
    },
  };
}

export { observeCertifiedGitHubSemanticRead } from './semantic-read.ts';
export type {
  CertifiedGitHubSemanticReadEvidence,
  CertifiedGitHubSemanticReadResult,
} from './semantic-read.ts';
