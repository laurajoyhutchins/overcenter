import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
export async function executeDeterministicWorkSettlement(request, ports) {
    const authority = executionAuthority(request);
    return executeBoundProviderEffect({
        operation_kind: 'deterministic.work.settle',
        request,
        authority,
        idempotency_scope: 'repository:' + authority.repository,
        payload: {
            work_ref: request.work_ref,
            predicate_key: request.predicate_key,
            target_state: request.target_state,
            evaluation: request.evaluation,
        },
        ports,
    });
}
