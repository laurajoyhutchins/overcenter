export type ProjectAuthoringCandidateReconciliationInput = Readonly<{
  staged_revision: string;
  current_revision: string;
  verified_revision: string;
  staged_definition_fingerprint: string;
  definition_fingerprint: string;
  staged_graph_fingerprint: string;
  graph_fingerprint: string;
  descendant_of_staged: boolean;
}>;

export type ProjectAuthoringCandidateReconciliation = Readonly<{
  candidate_revision: string;
  staged_revision: string;
  advanced: boolean;
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
  if (!SHA40.test(revision)) {
    fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', `${field} must be an exact Git commit SHA`, { field });
  }
  return revision;
}

function stableFingerprint(value: unknown, field: string): string {
  const fingerprint = typeof value === 'string' ? value.trim() : '';
  if (!fingerprint) {
    fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', `${field} is required`, { field });
  }
  return fingerprint;
}

export function reconcileProjectAuthoringCandidate(
  input: ProjectAuthoringCandidateReconciliationInput,
): ProjectAuthoringCandidateReconciliation {
  const staged = exactRevision(input?.staged_revision, 'staged_revision');
  const current = exactRevision(input?.current_revision, 'current_revision');
  const verified = exactRevision(input?.verified_revision, 'verified_revision');
  const stagedDefinition = stableFingerprint(input?.staged_definition_fingerprint, 'staged_definition_fingerprint');
  const currentDefinition = stableFingerprint(input?.definition_fingerprint, 'definition_fingerprint');
  const stagedGraph = stableFingerprint(input?.staged_graph_fingerprint, 'staged_graph_fingerprint');
  const currentGraph = stableFingerprint(input?.graph_fingerprint, 'graph_fingerprint');

  const advanced = current !== staged;
  if (advanced && input?.descendant_of_staged !== true) {
    fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', 'candidate head movement is not an authorized descendant of the staged revision', {
      staged_revision:staged,
      current_revision:current,
    });
  }
  if (currentDefinition !== stagedDefinition || currentGraph !== stagedGraph) {
    fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', 'candidate semantic identity changed after staging', {
      staged_revision:staged,
      current_revision:current,
      definition_matches:currentDefinition === stagedDefinition,
      graph_matches:currentGraph === stagedGraph,
    });
  }
  if (verified !== current) {
    fail('PROJECT_AUTHORING_CANDIDATE_VERIFICATION_STALE', 'candidate verification is not bound to the exact current head', {
      staged_revision:staged,
      current_revision:current,
      verified_revision:verified,
    });
  }

  return Object.freeze({ candidate_revision:current, staged_revision:staged, advanced });
}