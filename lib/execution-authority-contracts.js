export function normalizeExecutionAuthorityLocator(input, repositoryForFailure, fail) {
    const value = input && typeof input === 'object' && !Array.isArray(input)
        ? input
        : {};
    const leaseToken = typeof value.lease_token === 'string' ? value.lease_token.trim() : '';
    const leaseRef = typeof value.lease_ref === 'string' ? value.lease_ref.trim() : '';
    if (!leaseToken && !leaseRef) {
        return fail('EXECUTION_AUTHORITY_REQUIRED', 'an active Overcenter execution lease is required for this mutation', {
            repository: repositoryForFailure(),
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