import { deriveReleaseSemverPlan } from './release-semver-plan.js';
export const RELEASE_PUBLISH_RESULT_SCHEMA = 'release-publish-v1';
function fail(code, message, details = null, mayHaveMutated = false) {
    const error = new Error(message);
    Object.assign(error, { code, details, may_have_mutated: mayHaveMutated });
    throw error;
}
function record(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail('RELEASE_PUBLISH_INVALID', `${field} must be an object`, { field });
    }
    return value;
}
function text(value, field) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized)
        fail('RELEASE_PUBLISH_INVALID', `${field} must be a non-empty string`, { field });
    return normalized;
}
function authority(raw, field) {
    const input = record(raw, field);
    const kind = text(input.kind, `${field}.kind`).toLowerCase();
    const repository = text(input.repository, `${field}.repository`);
    const revision = text(input.revision, `${field}.revision`).toLowerCase();
    const derivation = text(input.derivation, `${field}.derivation`);
    if (kind !== 'github' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(revision)) {
        fail('RELEASE_PUBLISH_INVALID', `${field} must be an exact GitHub authority coordinate`, { field });
    }
    return Object.freeze({ kind: 'github', repository, revision, derivation });
}
function authorityKey(value) {
    return `${value.kind}:${value.repository}@${value.revision}#${value.derivation}`;
}
function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map((entry) => canonical(entry)).join(',')}]`;
    if (value && typeof value === 'object') {
        const input = value;
        return `{${Object.keys(input).sort().map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}
function strictReleaseFailure(result) {
    fail(typeof result.error === 'string' && result.error ? result.error : 'RELEASE_PUBLISH_PRIMITIVE_FAILED', typeof result.message === 'string' && result.message ? result.message : 'release publication primitive failed', result, result.may_have_mutated === true);
}
export async function publishReleasePlan(raw, dependencies) {
    if (!dependencies || typeof dependencies.resolveAuthority !== 'function' || typeof dependencies.readTransitions !== 'function' || typeof dependencies.createRelease !== 'function') {
        fail('RELEASE_PUBLISH_RUNTIME_UNAVAILABLE', 'release publication dependencies are unavailable');
    }
    const input = record(raw, 'release_publish');
    const plan = record(input.plan, 'plan');
    if (typeof input.body !== 'string' || input.body.length > 125000) {
        fail('RELEASE_PUBLISH_INVALID', 'body must be a string of at most 125000 characters', { field: 'body' });
    }
    const projectRef = text(plan.project_ref, 'plan.project_ref');
    const plannedAuthority = authority(plan.authority, 'plan.authority');
    if (projectRef !== `github:${plannedAuthority.repository}`) {
        fail('RELEASE_PUBLISH_INVALID', 'plan project_ref does not match plan repository authority', { project_ref: projectRef, repository: plannedAuthority.repository });
    }
    const currentAuthority = authority(await dependencies.resolveAuthority(Object.freeze({ project_ref: projectRef })), 'current_authority');
    if (authorityKey(currentAuthority) !== authorityKey(plannedAuthority)) {
        fail('RELEASE_PUBLISH_AUTHORITY_STALE', 'release plan authority no longer matches current project authority', {
            expected: plannedAuthority,
            actual: currentAuthority,
        });
    }
    const horizon = record(plan.horizon, 'plan.horizon');
    const transitions = await dependencies.readTransitions(Object.freeze({ project_ref: projectRef, authority: currentAuthority }));
    if (!Array.isArray(transitions))
        fail('RELEASE_PUBLISH_RUNTIME_INVALID', 'exact-revision transition definitions are unavailable');
    const verifiedPlan = await deriveReleaseSemverPlan(Object.freeze({
        project_ref: projectRef,
        authority: currentAuthority,
        horizon: Object.freeze({
            schema: 'project-horizon-v1',
            kind: 'release',
            ref: horizon.ref,
            authority: currentAuthority,
            authority_key: authorityKey(currentAuthority),
            target_node_ids: horizon.target_node_ids,
            scope_node_ids: horizon.scope_node_ids,
        }),
        base_release: plan.base_release,
        transitions,
    }));
    if (canonical(plan) !== canonical(verifiedPlan)) {
        fail('RELEASE_PUBLISH_PLAN_UNVERIFIED', 'release plan does not match deterministic exact-revision planning', {
            expected_fingerprint: verifiedPlan.fingerprint,
            observed_fingerprint: typeof plan.fingerprint === 'string' ? plan.fingerprint : null,
        });
    }
    if (!verifiedPlan.release_required) {
        fail('RELEASE_PUBLISH_NOT_REQUIRED', 'release plan does not require a new semantic version', {
            version: verifiedPlan.candidate_version,
            aggregate_impact: verifiedPlan.aggregate_impact,
        });
    }
    const tagName = `v${verifiedPlan.candidate_version}`;
    const primitiveRequest = Object.freeze({
        repo: currentAuthority.repository,
        target_sha: currentAuthority.revision,
        tag_name: tagName,
        name: tagName,
        body: input.body,
        draft: false,
        prerelease: false,
        expected_state: Object.freeze({ tag: 'absent', release: 'absent' }),
        idempotency_key: `release-publish:${verifiedPlan.fingerprint}`,
    });
    const rawResult = await dependencies.createRelease(primitiveRequest);
    const result = record(rawResult, 'release_result');
    if (result.ok !== true)
        strictReleaseFailure(result);
    const releaseId = Number(result.release_id);
    const releaseUrl = typeof result.release_url === 'string' ? result.release_url.trim() : '';
    if (result.verified !== true || result.verification_result !== 'verified' || result.post_state !== 'satisfied'
        || String(result.requested_commit_sha || '').toLowerCase() !== currentAuthority.revision
        || String(result.verified_commit_sha || '').toLowerCase() !== currentAuthority.revision
        || String(result.tag_name || '') !== tagName
        || !Number.isSafeInteger(releaseId) || releaseId < 1 || !releaseUrl) {
        fail('RELEASE_PUBLISH_CONFIRMATION_UNPROVEN', 'release primitive did not return exact verified publication evidence', result, result.may_have_mutated === true);
    }
    return Object.freeze({
        ok: true,
        schema: RELEASE_PUBLISH_RESULT_SCHEMA,
        project_ref: projectRef,
        version: verifiedPlan.candidate_version,
        tag_name: tagName,
        target_sha: currentAuthority.revision,
        plan_fingerprint: verifiedPlan.fingerprint,
        release_id: releaseId,
        release_url: releaseUrl,
        verified: true,
        idempotent_replay: result.idempotent_replay === true,
    });
}
