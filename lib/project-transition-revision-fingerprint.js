function requireText(value, field) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized)
        throw new TypeError(`${field} must be a non-empty string`);
    return normalized;
}
export async function projectTransitionRevisionFingerprint(definition) {
    const transitionId = requireText(definition.transition_id, 'transition_id');
    if (!Number.isInteger(definition.priority))
        throw new TypeError('priority must be an integer');
    const payload = JSON.stringify({
        schema: 'project-transition-revision-definition-v1',
        transition_id: transitionId,
        priority: definition.priority,
        executor: definition.executor ?? null,
        phase_bindings: definition.phase_bindings ?? {},
        ...(definition.execution_intent ? { execution_intent: {
            schema: definition.execution_intent.schema,
            desired_outcome: definition.execution_intent.desired_outcome,
            acceptance_evidence: definition.execution_intent.acceptance_evidence,
        } } : {}),
    });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
