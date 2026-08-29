export type ProjectAuthoringAuthority = Readonly<{
  project_ref: string;
  repository: string;
  revision: string;
  derivation: string;
}>;

export type ProjectAuthoringRuntimeDependencies = Readonly<{
  resolveAuthority(input: Readonly<{ project_ref: string }>): Promise<ProjectAuthoringAuthority>;
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

function exactRevision(value: unknown): string {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA40.test(revision)) {
    fail('PROJECT_AUTHORING_REQUEST_INVALID', 'expected_revision must be an exact 40-character Git commit SHA');
  }
  return revision;
}

export async function amendProjectDefinition(
  input: ProjectAmendRequest,
  dependencies: ProjectAuthoringRuntimeDependencies,
): Promise<never> {
  const projectRef = typeof input?.project_ref === 'string' ? input.project_ref.trim() : '';
  if (!projectRef || !dependencies || typeof dependencies.resolveAuthority !== 'function') {
    fail('PROJECT_AUTHORING_REQUEST_INVALID', 'project_ref and resolveAuthority are required');
  }
  const expectedRevision = exactRevision(input.expected_revision);
  const authority = await dependencies.resolveAuthority({ project_ref: projectRef });
  const observedRevision = exactRevision(authority?.revision);
  if (authority?.project_ref !== projectRef || observedRevision !== expectedRevision) {
    fail('PROJECT_AUTHORING_AUTHORITY_STALE', 'project authoring authority changed before mutation', {
      project_ref: projectRef,
      expected_revision: expectedRevision,
      observed_revision: observedRevision,
    });
  }
  fail('PROJECT_AUTHORING_RUNTIME_INCOMPLETE', 'project authoring mutation boundary is not implemented yet');
}