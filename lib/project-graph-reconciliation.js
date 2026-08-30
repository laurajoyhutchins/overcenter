function requireSemanticText(value, field) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
        throw new TypeError(`${field} must be a non-empty string`);
    }
    return normalized;
}
export function reconcileProjectTransitionPresence(previous, current) {
    if (previous === null && current !== null) {
        return Object.freeze({
            kind: 'introduced',
            transition_id: requireSemanticText(current.transition_id, 'current.transition_id'),
            definition_fingerprint: requireSemanticText(current.definition_fingerprint, 'current.definition_fingerprint'),
            may_continue_existing_authority: false,
            may_preserve_confirmation: false,
        });
    }
    if (previous !== null && current === null) {
        return Object.freeze({
            kind: 'removed',
            transition_id: requireSemanticText(previous.transition_id, 'previous.transition_id'),
            previous_definition_fingerprint: requireSemanticText(previous.definition_fingerprint, 'previous.definition_fingerprint'),
            may_continue_existing_authority: false,
            may_preserve_confirmation: false,
            synthesizes_completion: false,
        });
    }
    throw new TypeError('project transition presence reconciliation requires exactly one revision to be absent');
}
export function reconcileProjectTransitionRevision(previous, current, continuation) {
    const previousTransitionId = requireSemanticText(previous.transition_id, 'previous.transition_id');
    const currentTransitionId = requireSemanticText(current.transition_id, 'current.transition_id');
    if (previousTransitionId !== currentTransitionId) {
        throw new TypeError('project transition revision reconciliation requires one stable transition identity');
    }
    const previousFingerprint = requireSemanticText(previous.definition_fingerprint, 'previous.definition_fingerprint');
    const currentFingerprint = requireSemanticText(current.definition_fingerprint, 'current.definition_fingerprint');
    if (previousFingerprint !== currentFingerprint) {
        return Object.freeze({
            kind: 'redefined',
            transition_id: currentTransitionId,
            previous_definition_fingerprint: previousFingerprint,
            current_definition_fingerprint: currentFingerprint,
            may_continue_existing_authority: false,
            may_preserve_confirmation: false,
        });
    }
    const mutationScopeUnchanged = continuation?.mutation_scope_unchanged === true;
    const requiredAuthorityValid = continuation?.required_authority_valid === true;
    if (!mutationScopeUnchanged || !requiredAuthorityValid) {
        return Object.freeze({
            kind: 'authority-invalidated',
            transition_id: currentTransitionId,
            definition_fingerprint: currentFingerprint,
            mutation_scope_unchanged: mutationScopeUnchanged,
            required_authority_valid: requiredAuthorityValid,
            may_continue_existing_authority: false,
            may_preserve_confirmation: false,
        });
    }
    return Object.freeze({
        kind: 'unchanged',
        transition_id: currentTransitionId,
        definition_fingerprint: currentFingerprint,
        may_continue_existing_authority: true,
        may_preserve_confirmation: true,
    });
}