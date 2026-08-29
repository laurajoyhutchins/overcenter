const SHA40 = /^[0-9a-f]{40}$/;

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function exactRevision(value) {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA40.test(revision)) {
    fail('PROJECT_AUTHORING_REQUEST_INVALID', 'expected_revision must be an exact 40-character Git commit SHA');
  }
  return revision;
}

export async function amendProjectDefinition(input, dependencies) {
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