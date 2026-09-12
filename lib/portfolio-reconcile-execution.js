import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
export async function executePortfolioReconciliation(request, ports) {
    const authority = executionAuthority(request);
    return executeBoundProviderEffect({
        operation_kind: 'portfolio.reconcile',
        request,
        authority,
        idempotency_scope: 'repository:' + authority.repository,
        payload: {
            observation: request.observation,
            plan: request.plan,
        },
        ports,
    });
}
