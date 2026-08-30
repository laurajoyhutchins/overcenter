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
export function reconcileProjectTransitionDependencies(previous, current) {
    const previousTransitionId = requireSemanticText(previous.transition_id, 'previous.transition_id');
    const currentTransitionId = requireSemanticText(current.transition_id, 'current.transition_id');
    if (previousTransitionId !== currentTransitionId) {
        throw new TypeError('project transition dependency reconciliation requires one stable transition identity');
    }
    const previousFingerprint = requireSemanticText(previous.dependency_fingerprint, 'previous.dependency_fingerprint');
    const currentFingerprint = requireSemanticText(current.dependency_fingerprint, 'current.dependency_fingerprint');
    if (previousFingerprint !== currentFingerprint) {
        return Object.freeze({
            kind: 'dependency-changed',
            transition_id: currentTransitionId,
            previous_dependency_fingerprint: previousFingerprint,
            current_dependency_fingerprint: currentFingerprint,
            may_continue_existing_authority: false,
            may_preserve_confirmation: true,
        });
    }
    return Object.freeze({
        kind: 'dependency-unchanged',
        transition_id: currentTransitionId,
        dependency_fingerprint: currentFingerprint,
    });
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
export function reconcileProjectTransitionChange(previous, current, continuation) {
    const revision = reconcileProjectTransitionRevision(previous, current, continuation);
    if (revision.kind === 'redefined')
        return revision;
    const dependencies = reconcileProjectTransitionDependencies(previous, current);
    if (dependencies.kind === 'dependency-changed')
        return dependencies;
    return revision;
}
function indexProjectGraphTransitions(transitions, field) {
    const byId = new Map();
    for (const transition of transitions) {
        const transitionId = requireSemanticText(transition.transition_id, `${field}.transition_id`);
        if (byId.has(transitionId)) {
            throw new TypeError(`${field} contains duplicate transition identity ${transitionId}`);
        }
        byId.set(transitionId, transition);
    }
    return byId;
}
export function reconcileProjectGraphRevision(previous, current, continuationByTransition = {}) {
    const previousById = indexProjectGraphTransitions(previous, 'previous');
    const currentById = indexProjectGraphTransitions(current, 'current');
    const transitionIds = [...new Set([...previousById.keys(), ...currentById.keys()])].sort();
    return Object.freeze(transitionIds.map((transitionId) => {
        const previousTransition = previousById.get(transitionId) ?? null;
        const currentTransition = currentById.get(transitionId) ?? null;
        if (previousTransition === null || currentTransition === null) {
            return reconcileProjectTransitionPresence(previousTransition, currentTransition);
        }
        return reconcileProjectTransitionChange(previousTransition, currentTransition, continuationByTransition[transitionId] ?? {
            mutation_scope_unchanged: false,
            required_authority_valid: false,
        });
    }));
}