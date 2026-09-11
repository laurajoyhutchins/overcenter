const SHA40 = /^[0-9a-f]{40}$/;
function fail(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.may_have_mutated = false;
    error.details = Object.freeze({ ...details, may_have_mutated: false });
    throw error;
}
function exactRevision(value, field) {
    const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!SHA40.test(revision))
        fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', `${field} must be an exact Git commit SHA`, { field });
    return revision;
}
function optionalRevision(value, field) {
    if (value === undefined || value === null || value === '')
        return null;
    return exactRevision(value, field);
}
function stableFingerprint(value, field) {
    const fingerprint = typeof value === 'string' ? value.trim() : '';
    if (!fingerprint)
        fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', `${field} is required`, { field });
    return fingerprint;
}
function reconcileBaseMovement(input) {
    const stagedBase = optionalRevision(input?.staged_base_revision, 'staged_base_revision');
    const currentBase = optionalRevision(input?.current_base_revision, 'current_base_revision');
    if (!stagedBase && !currentBase)
        return {};
    if (!stagedBase || !currentBase) {
        fail('PROJECT_AUTHORING_BASE_RECONCILIATION_REQUIRED', 'base reconciliation requires both staged and current exact Git revisions', { staged_base_revision: stagedBase, current_base_revision: currentBase });
    }
    if (currentBase === stagedBase) {
        return { base_revision: currentBase, staged_base_revision: stagedBase, base_advanced: false };
    }
    if (input?.base_descendant_of_staged !== true || input?.base_semantics_compatible !== true) {
        fail('PROJECT_AUTHORING_BASE_RECONCILIATION_REQUIRED', 'base movement is conflicting or not mechanically derivable from the staged base', { staged_base_revision: stagedBase, current_base_revision: currentBase, descendant_of_staged: input?.base_descendant_of_staged === true, semantics_compatible: input?.base_semantics_compatible === true });
    }
    return { base_revision: currentBase, staged_base_revision: stagedBase, base_advanced: true };
}
export function reconcileProjectAuthoringCandidate(input) {
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
        fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', 'candidate head movement is not an authorized derivative of the staged revision', { staged_revision: staged, current_revision: current, descendant_of_staged: input?.descendant_of_staged === true, authorized_derivative: input?.authorized_derivative === true });
    }
    if (currentDefinition !== stagedDefinition || currentGraph !== stagedGraph) {
        fail('PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED', 'candidate semantic identity changed after staging', { staged_revision: staged, current_revision: current, definition_matches: currentDefinition === stagedDefinition, graph_matches: currentGraph === stagedGraph });
    }
    if (verified !== current) {
        fail('PROJECT_AUTHORING_CANDIDATE_VERIFICATION_STALE', 'candidate verification is not bound to the exact current head', { staged_revision: staged, current_revision: current, verified_revision: verified });
    }
    return Object.freeze({ candidate_revision: current, staged_revision: staged, advanced, ...base });
}
