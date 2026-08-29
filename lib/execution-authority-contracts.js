export const EXECUTION_GATES = [
    'lane:enable',
    'lane:source-implementation',
    'lane:repo-implementation',
    'lane:integration',
    'lane:verification',
];
const EXECUTION_GATE_SET = new Set(EXECUTION_GATES);
export function isExecutionGate(value) {
    return typeof value === 'string' && EXECUTION_GATE_SET.has(value);
}
export function normalizeExecutionAuthorityLocator(input, repository, fail) {
    const value = input && typeof input === 'object' && !Array.isArray(input)
        ? input
        : {};
    const leaseToken = typeof value.lease_token === 'string' ? value.lease_token.trim() : '';
    const leaseRef = typeof value.lease_ref === 'string' ? value.lease_ref.trim() : '';
    if (!leaseToken && !leaseRef) {
        return fail('EXECUTION_AUTHORITY_REQUIRED', 'an active Overcenter work lease is required for this mutation', {
            repository,
        });
    }
    if (leaseToken && leaseRef) {
        return fail('EXECUTION_AUTHORITY_INVALID', 'execution authority locator is ambiguous');
    }
    if (leaseToken.length > 256) {
        return fail('EXECUTION_AUTHORITY_INVALID', 'execution authority token is malformed');
    }
    if (leaseRef.length > 128) {
        return fail('EXECUTION_AUTHORITY_INVALID', 'execution authority lease reference is malformed');
    }
    return leaseRef
        ? Object.freeze({ lease_ref: leaseRef })
        : Object.freeze({ lease_token: leaseToken });
}
export function normalizeAllowedExecutionGates(value) {
    const allowedGates = new Set(Array.isArray(value) ? value.map(entry => String(entry)) : []);
    if (allowedGates.size === 0)
        throw new Error('execution authority allowed_gates must be non-empty');
    return allowedGates;
}
