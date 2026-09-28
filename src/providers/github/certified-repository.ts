import { GITHUB_REPOSITORY_OPERATION } from './operations.generated.ts';
import { materializeGitHubOperationRequest } from './openapi.ts';
import { observeCertifiedGitHubRead200 } from './certified-observation.ts';
import { GITHUB_REPOSITORY_RESPONSE_SLICE } from './semantics.ts';
import { githubGet, type GitHubJsonGet } from './rest.ts';

export interface RepositoryIdentityFact {
  kind: 'repository-identity';
  subject: { kind: 'github.repository'; id: number; node_id: string };
  relation: 'named';
  object: { owner: string; repo: string; full_name: string };
  stability: 'stable-subject-mutable-alias';
}

export interface CertifiedGitHubRepositoryEvidence {
  operation_id: 'repos/get';
  observed_at: string;
  node_id: string;
  canonical_full_name: string;
  validated_paths: string[];
  optional_absent_paths: string[];
}

export interface CertifiedGitHubRepository {
  fact: RepositoryIdentityFact;
  evidence: CertifiedGitHubRepositoryEvidence;
}

export function githubRepositoryCoordinate(fullName: string): { owner: string; repo: string } {
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1 || fullName.indexOf('/', slash + 1) !== -1) {
    throw new Error('GITHUB_REPOSITORY_FULL_NAME_INVALID');
  }
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

export function observeCertifiedGitHubRepository(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    get = githubGet,
    clock = () => new Date().toISOString(),
    observerId,
  }: {
    repositoryId: number;
    repositoryFullName: string;
    get?: GitHubJsonGet;
    clock?: () => string;
    observerId: string;
  },
): CertifiedGitHubRepository {
  const { owner, repo } = githubRepositoryCoordinate(repositoryFullName);
  const request = materializeGitHubOperationRequest(GITHUB_REPOSITORY_OPERATION, { owner, repo });
  const { observed_at: observedAt, certified } = observeCertifiedGitHubRead200({
    token,
    operation: GITHUB_REPOSITORY_OPERATION,
    request,
    fields: GITHUB_REPOSITORY_RESPONSE_SLICE,
    get,
    clock,
    observerId,
  });
  const value = certified.outcome.value as {
    id: number;
    node_id: string;
    full_name: string;
    name: string;
    owner: { login: string };
  };
  if (value.id <= 0 || value.node_id.length === 0) {
    throw new Error('GITHUB_REPOSITORY_OBSERVATION_INVALID');
  }
  if (
    value.owner.login.toLowerCase() !== owner.toLowerCase() ||
    value.name.toLowerCase() !== repo.toLowerCase() ||
    value.full_name.toLowerCase() !== `${value.owner.login}/${value.name}`.toLowerCase()
  ) {
    throw new Error('GITHUB_REPOSITORY_COORDINATE_MISMATCH');
  }
  if (value.id !== repositoryId) throw new Error('GITHUB_REPOSITORY_IDENTITY_MISMATCH');

  const fact: RepositoryIdentityFact = {
    kind: 'repository-identity',
    subject: { kind: 'github.repository', id: value.id, node_id: value.node_id },
    relation: 'named',
    object: { owner: value.owner.login, repo: value.name, full_name: value.full_name },
    stability: 'stable-subject-mutable-alias',
  };

  return {
    fact,
    evidence: {
      operation_id: 'repos/get',
      observed_at: observedAt,
      node_id: value.node_id,
      canonical_full_name: value.full_name,
      validated_paths: certified.structural_validation.validated_paths,
      optional_absent_paths: certified.structural_validation.optional_absent_paths,
    },
  };
}

export {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from './contract.ts';
export { GITHUB_REPOSITORY_OPERATION } from './operations.generated.ts';
export { GITHUB_REPOSITORY_RESPONSE_SLICE } from './semantics.ts';
export type { GitHubObservationOperation } from './openapi.ts';
export type { GitHubJsonGet } from './rest.ts';
