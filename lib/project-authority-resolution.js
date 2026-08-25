function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('PROJECT_AUTHORITY_RESOLUTION_INVALID', `${field} must be a non-empty string`, { field });
  return normalized;
}

function repositoryCoordinate(value) {
  const repository = text(value, 'repository');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    fail('PROJECT_AUTHORITY_RESOLUTION_INVALID', 'repository must be an explicit GitHub owner/name coordinate', { repository });
  }
  return repository;
}

const REVISION_POLICIES = Object.freeze(['default_branch_head', 'pull_request_head']);

export function normalizeProjectAuthorityResolutionContract(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('PROJECT_AUTHORITY_RESOLUTION_INVALID', 'project authority resolution contract must be an object');
  }

  const projectRef = text(input.project_ref, 'project_ref');
  const repository = repositoryCoordinate(input.repository);
  const revisionPolicy = text(input.revision_policy, 'revision_policy');
  if (!REVISION_POLICIES.includes(revisionPolicy)) {
    fail('PROJECT_AUTHORITY_RESOLUTION_INVALID', 'revision_policy is unsupported', { revision_policy:revisionPolicy });
  }
  const derivation = text(input.derivation, 'derivation');

  if (revisionPolicy === 'pull_request_head') {
    if (!Number.isInteger(input.pull_request) || input.pull_request <= 0) {
      fail('PROJECT_AUTHORITY_RESOLUTION_INVALID', 'pull_request_head policy requires a positive integer pull_request', { pull_request:input.pull_request ?? null });
    }
    return Object.freeze({
      schema:'project-authority-resolution-v1',
      project_ref:projectRef,
      repository,
      revision_policy:revisionPolicy,
      pull_request:input.pull_request,
      derivation,
    });
  }

  if (input.pull_request !== undefined && input.pull_request !== null) {
    fail('PROJECT_AUTHORITY_RESOLUTION_INVALID', 'pull_request is only valid with pull_request_head policy', { pull_request:input.pull_request });
  }

  return Object.freeze({
    schema:'project-authority-resolution-v1',
    project_ref:projectRef,
    repository,
    revision_policy:revisionPolicy,
    derivation,
  });
}

export const PROJECT_AUTHORITY_REVISION_POLICIES = REVISION_POLICIES;
