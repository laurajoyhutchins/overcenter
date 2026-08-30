export const PROJECT_DEFINITION_MUTATION_AUTHORITY_SCHEMA = 'project-definition-mutation-authority-v1';
const SHA40 = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function fail(code, message, details = null) {
    const error = new Error(message);
    Object.assign(error, { code, details });
    throw error;
}
function exactRevision(value, field) {
    const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!SHA40.test(revision))
        fail('PROJECT_DEFINITION_MUTATION_AUTHORITY_INVALID', `${field} must be an exact 40-character Git revision`, { field });
    return revision;
}
function normalizedRequest(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        fail('PROJECT_DEFINITION_MUTATION_AUTHORITY_INVALID', 'project definition mutation authority request must be an object');
    const input = raw;
    const operation = input.operation === 'define' || input.operation === 'amend' ? input.operation : null;
    if (!operation)
        fail('PROJECT_DEFINITION_MUTATION_AUTHORITY_INVALID', 'operation must be define or amend');
    const repository = typeof input.repository === 'string' ? input.repository.trim() : '';
    if (!REPOSITORY.test(repository))
        fail('PROJECT_DEFINITION_MUTATION_AUTHORITY_INVALID', 'repository must be owner/repo');
    const projectRef = typeof input.project_ref === 'string' ? input.project_ref.trim() : '';
    if (projectRef !== `github:${repository}`)
        fail('PROJECT_DEFINITION_MUTATION_AUTHORITY_SCOPE_MISMATCH', 'project_ref must identify the requested repository', { project_ref: projectRef, repository });
    return Object.freeze({ operation, project_ref: projectRef, repository, expected_revision: exactRevision(input.expected_revision, 'expected_revision') });
}
export function createProjectDefinitionMutationAuthorityPolicy(dependencies) {
    if (!dependencies || typeof dependencies.readRepositoryDisposition !== 'function' || typeof dependencies.readSourceRevision !== 'function') {
        throw new Error('project definition mutation authority policy requires repository disposition and source revision readers');
    }
    return Object.freeze({
        async require(raw) {
            const request = normalizedRequest(raw);
            const disposition = await dependencies.readRepositoryDisposition(request.repository);
            if (!disposition || disposition.repository !== request.repository || disposition.disposition !== 'ACTIVE') {
                fail('PROJECT_DEFINITION_MUTATION_AUTHORITY_STALE', 'repository is not active for project definition mutation', { repository: request.repository, disposition: disposition?.disposition ?? null });
            }
            const currentRevision = exactRevision(await dependencies.readSourceRevision(request.repository), 'current_revision');
            if (currentRevision !== request.expected_revision) {
                fail('PROJECT_DEFINITION_MUTATION_AUTHORITY_STALE', 'repository source authority changed after observation', { repository: request.repository, expected_revision: request.expected_revision, current_revision: currentRevision });
            }
            return Object.freeze({
                schema: PROJECT_DEFINITION_MUTATION_AUTHORITY_SCHEMA,
                subject: 'project_definition',
                operation: request.operation,
                project_ref: request.project_ref,
                repository: request.repository,
                authority_revision: currentRevision,
            });
        },
    });
}
