import {
  observeCertifiedGitHubRead,
  type CertifiedGitHubReadEvidence,
  type GitHubGenericSemanticOperationName,
} from './certified-read.ts';
import {
  observeCertifiedGitHubRepository,
  type CertifiedGitHubRepositoryEvidence,
} from './certified-repository.ts';
import {
  GITHUB_OPERATION_SEMANTICS,
  type GitHubRepositoryReadPermission,
} from './semantics.ts';
import { GITHUB_OBSERVATION_OPERATIONS } from './operations.generated.ts';
import { GitHubAsyncReadRequired, githubGet, type GitHubJsonGet } from './rest.ts';

export interface CertifiedGitHubSemanticReadEvidence extends CertifiedGitHubReadEvidence {
  repository_id: number;
  repository: CertifiedGitHubRepositoryEvidence;
}

export type CertifiedGitHubSemanticReadResult =
  | {
      state: 'observed' | 'page-observed';
      value: unknown;
      evidence: CertifiedGitHubSemanticReadEvidence;
    }
  | {
      state: 'indeterminate';
      operation_key: GitHubGenericSemanticOperationName;
      operation_id: string;
      observation_error: string;
    };

export function observeCertifiedGitHubSemanticRead(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    operation: operationName,
    parameters = {},
    grantedPermissions,
    get = githubGet,
    clock = () => new Date().toISOString(),
    observerId = 'github-semantic-read/v1',
  }: {
    repositoryId: number;
    repositoryFullName: string;
    operation: GitHubGenericSemanticOperationName;
    parameters?: Record<string, string | number | boolean>;
    grantedPermissions: readonly GitHubRepositoryReadPermission[];
    get?: GitHubJsonGet;
    clock?: () => string;
    observerId?: string;
  },
): CertifiedGitHubSemanticReadResult {
  const operation = GITHUB_OBSERVATION_OPERATIONS[operationName];
  const semantic = GITHUB_OPERATION_SEMANTICS[operationName];
  const granted = new Set<GitHubRepositoryReadPermission>(grantedPermissions);
  const missing = semantic.required_permissions.filter((permission) => !granted.has(permission));
  if (missing.length > 0) {
    return {
      state: 'indeterminate',
      operation_key: operationName,
      operation_id: operation.operation_id,
      observation_error: `GITHUB_SEMANTIC_READ_PERMISSION_NOT_GRANTED:${missing.join(',')}`,
    };
  }

  try {
    const repository = observeCertifiedGitHubRepository(token, {
      repositoryId,
      repositoryFullName,
      get,
      clock,
      observerId,
    });
    const read = observeCertifiedGitHubRead(token, {
      repositoryFullName: repository.fact.object.full_name,
      operation: operationName,
      parameters,
      get,
      clock,
      observerId,
    });
    return {
      ...read,
      evidence: {
        ...read.evidence,
        repository_id: repositoryId,
        requested_repository_full_name: repositoryFullName,
        repository: repository.evidence,
      },
    };
  } catch (error: unknown) {
    if (error instanceof GitHubAsyncReadRequired) throw error;
    return {
      state: 'indeterminate',
      operation_key: operationName,
      operation_id: operation.operation_id,
      observation_error: error instanceof Error ? error.message : String(error),
    };
  }
}
