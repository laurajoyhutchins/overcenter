import { canonicalJson, sha256Text } from './canonical-json.js';
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function fail(message, details = {}) {
    const error = new Error(message);
    error.code = 'PROJECT_TRANSITION_GITHUB_WORKSPACE_INVALID';
    error.details = details;
    throw error;
}
function text(value, field, max = 512) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || normalized.length > max)
        return fail(`${field} is invalid`, { field });
    return normalized;
}
function transitionSlug(value) {
    const slug = value.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96)
        .replace(/-+$/g, '');
    return slug || 'transition';
}
export async function deriveProjectTransitionGithubWorkspace(authority) {
    if (!authority || authority.subject !== 'project_transition')
        return fail('execution authority must be a project transition');
    const repository = text(authority.repository, 'repository', 256);
    if (!REPOSITORY.test(repository))
        return fail('repository is invalid', { repository });
    const projectRef = text(authority.project_ref, 'project_ref');
    const transitionId = text(authority.transition_id, 'transition_id', 256);
    const transitionFingerprint = text(authority.transition_definition_fingerprint, 'transition_definition_fingerprint', 256);
    const gitAuthority = authority.authority && typeof authority.authority === 'object' && !Array.isArray(authority.authority)
        ? authority.authority
        : null;
    const authorityRepository = text(gitAuthority?.repository, 'authority.repository', 256);
    const authorityRevision = text(gitAuthority?.revision, 'authority.revision', 40).toLowerCase();
    if (gitAuthority?.kind !== 'github' || authorityRepository !== repository || !SHA40.test(authorityRevision)) {
        return fail('project transition authority must be exact GitHub repository authority');
    }
    const generation = {
        schema: 'project-transition-github-workspace-generation-v1',
        repository,
        project_ref: projectRef,
        transition_id: transitionId,
        transition_definition_fingerprint: transitionFingerprint,
        authority_revision: authorityRevision,
    };
    const workspaceDigest = await sha256Text(canonicalJson(generation));
    return Object.freeze({
        ...generation,
        workspace_digest: workspaceDigest,
        branch: `work/${transitionSlug(transitionId)}-${workspaceDigest.slice(0, 24)}`,
    });
}
export async function projectTransitionGithubChangesetIdempotencyKey(input) {
    const leaseRef = text(input?.lease_ref, 'lease_ref', 128);
    const workspaceDigest = text(input?.workspace_digest, 'workspace_digest', 64).toLowerCase();
    const changesetSha256 = text(input?.changeset_sha256, 'changeset_sha256', 64).toLowerCase();
    const observedHead = input?.observed_head === null ? null : text(input?.observed_head, 'observed_head', 40).toLowerCase();
    if (!SHA256.test(workspaceDigest) || !SHA256.test(changesetSha256) || (observedHead !== null && !SHA40.test(observedHead))) {
        return fail('project transition GitHub changeset identity is malformed');
    }
    const digest = await sha256Text(canonicalJson({
        schema: 'project-transition-github-changeset-intent-v1',
        lease_ref: leaseRef,
        workspace_digest: workspaceDigest,
        observed_head: observedHead,
        changeset_sha256: changesetSha256,
    }));
    return `project-transition-changeset-v1:${digest}`;
}
