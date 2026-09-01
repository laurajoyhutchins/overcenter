function failExecutionState(message, details = null) {
    throw Object.assign(new Error(message), { code: 'EXECUTION_STATE_INVALID', details });
}
function nonNegativeInteger(value, field) {
    if (!Number.isInteger(value) || Number(value) < 0) {
        return failExecutionState(`${field} must be a non-negative integer`, { field, value });
    }
    return Number(value);
}
function requiredText(value, field) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text)
        return failExecutionState(`${field} is required`, { field });
    return text;
}
export function assertExecutionState(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        failExecutionState('execution state must be an object');
    }
    const state = value;
    requiredText(state.subject_key, 'subject_key');
    if (state.subject_kind !== 'project_transition' && state.subject_kind !== 'legacy_work') {
        failExecutionState('subject_kind is invalid', { subject_kind: state.subject_kind });
    }
    nonNegativeInteger(state.authority_epoch, 'authority_epoch');
    nonNegativeInteger(state.heartbeat_count, 'heartbeat_count');
    nonNegativeInteger(state.no_progress_streak, 'no_progress_streak');
    if (!Array.isArray(state.recent_progress_sha256) || state.recent_progress_sha256.length > 2) {
        failExecutionState('recent_progress_sha256 must contain at most two hashes', {
            count: Array.isArray(state.recent_progress_sha256) ? state.recent_progress_sha256.length : null,
        });
    }
    for (const hash of state.recent_progress_sha256) {
        requiredText(hash, 'recent_progress_sha256');
    }
    const leaseRef = state.lease_ref == null ? null : requiredText(state.lease_ref, 'lease_ref');
    if (leaseRef) {
        requiredText(state.run_id, 'run_id');
        requiredText(state.authority_repository, 'authority_repository');
        requiredText(state.authority_revision, 'authority_revision');
        requiredText(state.expires_at, 'expires_at');
        requiredText(state.hard_expires_at, 'hard_expires_at');
    }
    requiredText(state.updated_at, 'updated_at');
}
export function assertTerminalOperationCompactable(operation) {
    if (operation.state === 'prepared' || operation.state === 'indeterminate') {
        throw Object.assign(new Error('operation is not terminal'), { code: 'OPERATION_NOT_COMPACTABLE' });
    }
    if (operation.state === 'succeeded' && operation.may_have_mutated && !operation.effect_ref) {
        throw Object.assign(new Error('successful mutation lacks a proven effect identity'), { code: 'OPERATION_EFFECT_UNPROVEN' });
    }
}
