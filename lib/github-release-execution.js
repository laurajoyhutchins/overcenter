import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
export async function executeGithubRelease(request, ports) {
    const authority = executionAuthority(request);
    return executeBoundProviderEffect({
        operation_kind: 'github.release.create',
        request,
        authority,
        idempotency_scope: 'repository:' + authority.repository,
        payload: {
            repo: request.repo,
            target_revision: request.target_revision,
            tag_name: request.tag_name,
            body: request.body,
        },
        ports,
    });
}
