const SHA40 = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function invalid(message, details = {}) {
  return Object.assign(new Error(message), {
    code:'GCP_SEMANTIC_RELAY_INVALID',
    may_have_mutated:false,
    details,
  });
}

export function normalizeProjectAmendInput(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const projectRef = String(input.project_ref || '').trim();
  const expectedRevision = String(input.expected_revision || '').trim().toLowerCase();
  if (!PROJECT_REF.test(projectRef)) throw invalid('project_ref must be a canonical github:owner/repo reference');
  if (!SHA40.test(expectedRevision)) throw invalid('expected_revision must be an exact 40-character Git SHA');
  if (!input.amendment || typeof input.amendment !== 'object' || Array.isArray(input.amendment)) throw invalid('amendment must be an object');
  return Object.freeze({
    project_ref:projectRef,
    expected_revision:expectedRevision,
    amendment:input.amendment,
  });
}
