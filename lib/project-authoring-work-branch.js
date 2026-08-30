const DIGEST = /^[0-9a-f]{64}$/;
function fail(message, details = {}) {
    const error = new Error(message);
    error.code = 'PROJECT_AUTHORING_WORK_BRANCH_INVALID';
    error.details = details;
    throw error;
}
export function projectAuthoringWorkBranch(input) {
    const operation = input?.operation;
    if (operation !== 'define' && operation !== 'amend') {
        return fail('project authoring operation must be define or amend', { operation });
    }
    const idempotencyKey = typeof input?.idempotency_key === 'string' ? input.idempotency_key.trim() : '';
    const prefix = `project-${operation}-v1:`;
    if (!idempotencyKey.startsWith(prefix)) {
        if (idempotencyKey.startsWith('project-')) {
            return fail('semantic idempotency key does not match operation', { operation, idempotency_key: idempotencyKey });
        }
        return fail('project authoring work branch requires a semantic idempotency key', { operation });
    }
    const digest = idempotencyKey.slice(prefix.length);
    if (!DIGEST.test(digest)) {
        return fail('project authoring work branch requires a semantic idempotency key', { operation });
    }
    return `chore/project-authoring-${operation}-${digest.slice(0, 24)}`;
}
