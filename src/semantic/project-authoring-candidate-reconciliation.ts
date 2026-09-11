type ProjectAuthoringCandidateReconciliationInput = Readonly<{
  staged_revision: string;
  current_revision: string;
  verified_revision: string;
  staged_definition_fingerprint: string;
  definition_fingerprint: string;
  staged_graph_fingerprint: string;
  graph_fingerprint: string;
  descendant_of_staged: boolean;
  authorized_derivative?: boolean;
  staged_base_revision?: string;
  current_base_revision?: string;
  base_descendant_of_staged?: boolean;
  base_semantics_compatible?: boolean;
}>;

type ProjectAuthoringCandidateReconciliation = Readonly<{
  candidate_revision: string;
  staged_revision: string;
  advanced: boolean;
  base_revision?: string;
  staged_base_revision?: string;
  base_advanced?: boolean;
}>;

type CandidateReconciliationError = Error & {
  code: string;
  may_have_mutated: false;
  details: Readonly<Record<string, unknown>>;
};

const SHA40 = /^[0-9a-f]{40}$/;

function fail(code: string, message: string, details: Readonly<Record<string, unknown>>): never {
  const error = new Error(message) as CandidateReconciliationError;
  error.code = code;
  error.may_have_mutated = false;
  error.details = Object.freeze({ ...details, may_have_mutated:false });
  throw error;
}

function exactRevision(value: unknown, field: string): string {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA40.test(revision)) fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', `${field} must be an exact Git commit SHA`, { field });
  return revision;
}

function optionalRevision(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return exactRevision(value, field);
}

function stableFingerprint(value: unknown, field: string): string {
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  if (!fingerprint) fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', `${field} is required`, { field });
  return fingerprint;
}

function reconcileBaseMovement(input: ProjectAuthoringCandidateReconciliationInput): Readonly<{
  base_revision?: string;
  staged_base_revision?: string;
  base_advanced?: boolean;
}> {
  const stagedBase = optionalRevision(input?.staged_base_revision, 'staged_base_revision');
  const currentBase = optionalRevision(input?.current_base_revision, 'current_base_revision');
  if (!stagedBase && !currentBase) return Object.freeze({});
  if (!stagedBase || !currentBase) {
    fail('PROJECT_AUTHORING_BASE_RECONCILIATION_REQUIRED', 'base reconciliation requires both staged and current exact Git revisions', { staged_base_revision:stagedBase, current_base_revision:currentBase });
  }
  if (currentBase === stagedBase) {
    return Object.freeze({ base_revision:currentBase, staged_base_revision:stagedBase, base_advanced:false });
  }
  if (input?.base_descendant_of_staged !== true || input?.base_semantics_compatible !== true) {
    fail('PROJECT_AUTHORING_BASE_RECONCILIATION_REQUIRED', 'base movement is conflicting or not mechanically derivable from the staged base', { staged_base_revision:stagedBase, current_base_revision:currentBase, descendant_of_staged:input?.base_descendant_of_staged === true, semantics_compatible:input?.base_semantics_compatible === true });
  }
  return Object.freeze({ base_revision:currentBase, staged_base_revision:stagedBase, base_advanced:true });
}

export function reconcileProjectAuthoringCandidate(input: ProjectAuthoringCandidateReconciliationInput): ProjectAuthoringCandidateReconciliation {
  const staged = exactRevision(input?.staged_revision, 'staged_revision');
  const current = exactRevision(input?.current_revision, 'current_revision');
  const verified = exactRevision(input?.verified_revision, 'verified_revision');
  const stagedDefinition = stableFingerprint(input?.staged_definition_fingerprint, 'staged_definition_fingerprint');
  const currentDefinition = stableFingerprint(input?.definition_fingerprint, 'definition_fingerprint');
  const stagedGraph = stableFingerprint(input?.staged_graph_fingerprint, 'staged_graph_fingerprint');
  const currentGraph = stableFingerprint(input?.graph_fingerprint, 'graph_fingerprint');
  const base = reconcileBaseMovement(input);
  const advanced = current !== staged;
  if (advanced && (input?.descendant_of_staged !== true || input?.authorized_derivative !== true)) {
    fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', 'candidate head movement is not an authorized derivative of the staged revision', { staged_revision:staged, current_revision:current, descendant_of_staged:input?.descendant_of_staged === true, authorized_derivative:input?.authorized_derivative === true });
  }
  if (currentDefinition !== stagedDefinition || currentGraph !== stagedGraph) {
    fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', 'candidate semantic identity changed after staging', { staged_revision:staged, current_revision:current, definition_matches:currentDefinition === stagedDefinition, graph_matches:currentGraph === stagedGraph });
  }
  if (verified !== current) {
    fail('PROJECT_AUTHORING_CANDIDATE_VERIFICATION_STALE', 'candidate verification is not bound to the exact current head', { staged_revision:staged, current_revision:current, verified_revision:verified });
  }
  return Object.freeze({ candidate_revision:current, staged_revision:staged, advanced, ...base });
}
