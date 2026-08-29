import { applyProjectDefinitionAmendment } from './project-authoring.js';
import type { CanonicalProjectDefinition, ProjectDefinitionDiff } from './project-authoring.js';

export type ProjectAuthoringAuthority = Readonly<{
  project_ref: string;
  repository: string;
  revision: string;
  derivation: string;
}>;

export type ProjectAuthoringMutationRequest = Readonly<{
  project_ref: string;
  repository: string;
  expected_revision: string;
  derivation: string;
  definition: CanonicalProjectDefinition;
  diff: ProjectDefinitionDiff;
}>;

export type ProjectAuthoringRuntimeDependencies = Readonly<{
  resolveAuthority(input: Readonly<{ project_ref: string }>): Promise<ProjectAuthoringAuthority>;
  readDefinition(authority: ProjectAuthoringAuthority): Promise<unknown>;
  mutateDefinition(request: ProjectAuthoringMutationRequest): Promise<Readonly<{ revision: string }>>;
  deriveProjectGraph(authority: ProjectAuthoringAuthority): Promise<unknown>;
}>;

export type ProjectAmendRequest = Readonly<{
  project_ref: string;
  expected_revision: string;
  amendment: Readonly<Record<string, unknown>>;
}>;

const SHA40 = /^[0-9a-f]{40}$/;

function fail(code: string, message: string, details: Readonly<Record<string, unknown>> | null = null): never {
  const error = new Error(message) as Error & { code?: string; details?: Readonly<Record<string, unknown>> | null };
  error.code = code;
  error.details = details;
  throw error;
}

function exactRevision(value: unknown, field = 'expected_revision'): string {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA40.test(revision)) {
    fail('PROJECT_AUTHORING_REQUEST_INVALID', `${field} must be an exact 40-character Git commit SHA`);
  }
  return revision;
}

function requireDependencies(dependencies: ProjectAuthoringRuntimeDependencies): void {
  for (const name of ['resolveAuthority','readDefinition','mutateDefinition','deriveProjectGraph'] as const) {
    if (!dependencies || typeof dependencies[name] !== 'function') {
      fail('PROJECT_AUTHORING_REQUEST_INVALID', `${name} dependency is required`);
    }
  }
}

export async function amendProjectDefinition(
  input: ProjectAmendRequest,
  dependencies: ProjectAuthoringRuntimeDependencies,
) {
  const projectRef = typeof input?.project_ref === 'string' ? input.project_ref.trim() : '';
  if (!projectRef) fail('PROJECT_AUTHORING_REQUEST_INVALID', 'project_ref is required');
  requireDependencies(dependencies);
  const expectedRevision = exactRevision(input.expected_revision);
  const authority = await dependencies.resolveAuthority({ project_ref: projectRef });
  const observedRevision = exactRevision(authority?.revision, 'authority.revision');
  if (authority?.project_ref !== projectRef || observedRevision !== expectedRevision) {
    fail('PROJECT_AUTHORING_AUTHORITY_STALE', 'project authoring authority changed before mutation', {
      project_ref: projectRef,
      expected_revision: expectedRevision,
      observed_revision: observedRevision,
    });
  }

  const currentDefinition = await dependencies.readDefinition(authority);
  const amendment = applyProjectDefinitionAmendment(currentDefinition, input.amendment);
  const mutation = await dependencies.mutateDefinition({
    project_ref: projectRef,
    repository: authority.repository,
    expected_revision: expectedRevision,
    derivation: authority.derivation,
    definition: amendment.definition,
    diff: amendment.diff,
  });
  const resultingRevision = exactRevision(mutation?.revision, 'mutation.revision');
  const resultingAuthority = Object.freeze({ ...authority, revision: resultingRevision });
  const graph = await dependencies.deriveProjectGraph(resultingAuthority);
  return Object.freeze({
    schema:'project-authoring-result-v1' as const,
    authority:resultingAuthority,
    diff:amendment.diff,
    graph,
  });
}