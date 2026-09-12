import { executeBoundProviderEffect, executionAuthority } from './execution-provider-wrapper.js';
export async function executeGithubChangeset(request, ports) {
    const authority = executionAuthority(request);
    return executeBoundProviderEffect({
        operation_kind: 'github.changeset.apply',
        request,
        authority,
        idempotency_scope: 'repository:' + authority.repository,
        payload: {
            repo: request.repo,
            branch: request.branch,
            base_revision: request.base_revision,
            expected_head: request.expected_head,
            changes: request.changes,
            commit_message: request.commit_message,
        },
        ports,
    });
}
