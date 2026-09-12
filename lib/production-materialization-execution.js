import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
export function executeProductionMaterialization(request, ports) {
    const authority = executionAuthority(request);
    return executeBoundProviderEffect({
        operation_kind: 'production.materialize',
        request,
        authority,
        idempotency_scope: 'repository:' + authority.repository,
        payload: {
            repo: request.repo,
            branch: request.branch,
            source_revision: request.source_revision,
            runtime_ref: request.runtime_ref,
            expected_version: request.expected_version,
            source_manifest_sha256: request.source_manifest_sha256,
        },
        ports,
    });
}
