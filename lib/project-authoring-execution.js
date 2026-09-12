import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
export async function executeProjectAuthoring(request, ports) {
    const authority = executionAuthority(request);
    return executeBoundProviderEffect({
        operation_kind: 'project.authoring',
        request,
        authority,
        idempotency_scope: 'repository:' + authority.repository,
        payload: {
            expected_revision: request.expected_revision,
            definition: request.definition,
            amendment: request.amendment,
        },
        ports,
    });
}
