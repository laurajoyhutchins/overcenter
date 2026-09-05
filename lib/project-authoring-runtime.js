import { mayHaveMutated, mutationCertaintyFromEvidence } from './mutation-certainty.js';
import { applyProjectDefinitionAmendment, canonicalProjectDefinition } from './project-authoring.js';
const SHA40 = /^[0-9a-f]{40}$/;
function fail(code, message, details = null) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
}
function exactRevision(value, field = 'expected_revision') {
    const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!SHA40.test(revision)) {
        fail('PROJECT_AUTHORING_REQUEST_INVALID', `${field} must be an exact 40-character Git commit SHA`);
    }
    return revision;
}
function projectRefOf(input) {
    const projectRef = typeof input?.project_ref === 'string' ? input.project_ref.trim() : '';
    if (!projectRef)
        fail('PROJECT_AUTHORING_REQUEST_INVALID', 'project_ref is required');
    return projectRef;
}
function requireDependencies(dependencies) {
    for (const name of ['resolveAuthority', 'readDefinition', 'mutateDefinition', 'deriveProjectGraph']) {
        if (!dependencies || typeof dependencies[name] !== 'function') {
            fail('PROJECT_AUTHORING_REQUEST_INVALID', `${name} dependency is required`);
        }
    }
}
function confirmedMutationFailure(errorInput) {
    const error = errorInput instanceof Error
        ? errorInput
        : new Error(String(errorInput || 'project authoring readback failed'));
    const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? error.details
        : {};
    error.may_have_mutated = true;
    error.details = Object.freeze({ ...details, may_have_mutated: true });
    return error;
}
function mutationFailure(errorInput) {
    const error = errorInput instanceof Error
        ? errorInput
        : new Error(String(errorInput || 'project authoring mutation failed'));
    const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? error.details
        : {};
    const explicit = error.may_have_mutated ?? details.may_have_mutated;
    const fallback = explicit === undefined
        ? 'possible'
        : Boolean(explicit) ? 'possible' : 'none';
    const evidence = details.result ?? errorInput;
    const certainty = mutationCertaintyFromEvidence(evidence, fallback);
    error.may_have_mutated = mayHaveMutated(certainty);
    error.details = Object.freeze({
        ...details,
        may_have_mutated: error.may_have_mutated,
        mutation_certainty: certainty,
    });
    return error;
}
async function mutateProjectDefinition(request, dependencies) {
    try {
        return await dependencies.mutateDefinition(request);
    }
    catch (error) {
        throw mutationFailure(error);
    }
}
async function fencedAuthority(projectRef, expectedRevision, dependencies) {
    const authority = await dependencies.resolveAuthority({ project_ref: projectRef });
    const observedRevision = exactRevision(authority?.revision, 'authority.revision');
    if (authority?.project_ref !== projectRef || observedRevision !== expectedRevision) {
        fail('PROJECT_AUTHORING_AUTHORITY_STALE', 'project authoring authority changed before mutation', {
            project_ref: projectRef,
            expected_revision: expectedRevision,
            observed_revision: observedRevision,
        });
    }
    return authority;
}
function graphAtRevision(graphInput, authority) {
    if (!graphInput || typeof graphInput !== 'object' || Array.isArray(graphInput)) {
        fail('PROJECT_AUTHORING_READBACK_MISMATCH', 'derived project graph readback is invalid', {
            project_ref: authority.project_ref,
            expected_revision: authority.revision,
        });
    }
    const graph = graphInput;
    if (graph.revision == null) {
        return Object.freeze({ ...graph, revision: authority.revision });
    }
    const graphRevision = exactRevision(graph.revision, 'graph.revision');
    if (graphRevision !== authority.revision) {
        fail('PROJECT_AUTHORING_READBACK_MISMATCH', 'derived project graph does not match confirmed source revision', {
            project_ref: authority.project_ref,
            expected_revision: authority.revision,
            observed_revision: graphRevision,
        });
    }
    return graph;
}
function canonicalDefinitionsMatch(observedInput, expected) {
    if (observedInput == null)
        return false;
    try {
        return JSON.stringify(canonicalProjectDefinition(observedInput)) === JSON.stringify(expected);
    }
    catch {
        return false;
    }
}
function refreshedAuthority(initial, observedInput, stagedRevision) {
    const observedRevision = exactRevision(observedInput?.revision, 'authority.revision');
    if (observedInput?.project_ref !== initial.project_ref
        || observedInput?.repository !== initial.repository
        || observedInput?.derivation !== initial.derivation) {
        fail('PROJECT_AUTHORING_READBACK_MISMATCH', 'refreshed project authority identity changed after mutation', {
            project_ref: initial.project_ref,
            staged_revision: stagedRevision,
            expected_repository: initial.repository,
            observed_repository: observedInput?.repository ?? null,
            expected_derivation: initial.derivation,
            observed_derivation: observedInput?.derivation ?? null,
            observed_authority_revision: observedRevision,
        });
    }
    return Object.freeze({ ...observedInput, revision: observedRevision });
}
function amendmentTouchesExistingTransition(currentDefinitionInput, amendmentInput) {
    const currentDefinition = canonicalProjectDefinition(currentDefinitionInput);
    const existingIds = new Set(currentDefinition.transitions.map((transition) => transition.id));
    const removed = Array.isArray(amendmentInput?.remove_transition_ids) ? amendmentInput.remove_transition_ids : [];
    const upserted = Array.isArray(amendmentInput?.upsert_transitions) ? amendmentInput.upsert_transitions : [];
    return removed.some((id) => typeof id === 'string' && existingIds.has(id.trim()))
        || upserted.some((transition) => transition && typeof transition === 'object' && !Array.isArray(transition)
            && typeof transition.id === 'string'
            && existingIds.has(String(transition.id).trim()));
}
function confirmedTransitionIds(projectRef, observationsInput) {
    if (!Array.isArray(observationsInput)) {
        fail('PROJECT_AUTHORING_CONFIRMATION_HISTORY_INVALID', 'authoritative project confirmation history must be an array', { project_ref: projectRef });
    }
    const ids = new Set();
    for (const observationInput of observationsInput) {
        if (!observationInput || typeof observationInput !== 'object' || Array.isArray(observationInput)) {
            fail('PROJECT_AUTHORING_CONFIRMATION_HISTORY_INVALID', 'authoritative project confirmation history contains an invalid observation', { project_ref: projectRef });
        }
        const observation = observationInput;
        const transitionId = typeof observation.transition_id === 'string' ? observation.transition_id.trim() : '';
        if (observation.schema !== 'project-transition-observation-v1'
            || observation.kind !== 'project_transition_confirmation'
            || observation.project_ref !== projectRef
            || observation.disposition !== 'completed'
            || !transitionId) {
            fail('PROJECT_AUTHORING_CONFIRMATION_HISTORY_INVALID', 'authoritative project confirmation history contains an invalid completed transition observation', { project_ref: projectRef });
        }
        ids.add(transitionId);
    }
    return Object.freeze([...ids].sort());
}
async function amendmentWithAuthoritativeHistory(projectRef, authority, currentDefinition, amendmentInput, dependencies) {
    if (!amendmentTouchesExistingTransition(currentDefinition, amendmentInput))
        return amendmentInput;
    if (typeof dependencies.readProjectObservations !== 'function') {
        fail('PROJECT_AUTHORING_CONFIRMATION_HISTORY_UNAVAILABLE', 'project amendment requires authoritative confirmation history before changing an existing transition', { project_ref: projectRef });
    }
    const ids = confirmedTransitionIds(projectRef, await dependencies.readProjectObservations(authority));
    return Object.freeze({ ...amendmentInput, confirmed_transition_ids: ids });
}
async function resultAfterMutation(authority, mutation, expectedDefinition, diff, dependencies) {
    const stagedRevision = exactRevision(mutation?.revision, 'mutation.revision');
    const observedAuthority = refreshedAuthority(authority, await dependencies.resolveAuthority({ project_ref: authority.project_ref }), stagedRevision);
    const observedDefinition = await dependencies.readDefinition(observedAuthority);
    if (!canonicalDefinitionsMatch(observedDefinition, expectedDefinition)) {
        fail('PROJECT_AUTHORING_READBACK_MISMATCH', 'project authoring mutation is not observable through refreshed project authority', {
            project_ref: authority.project_ref,
            staged_revision: stagedRevision,
            observed_authority_revision: observedAuthority.revision,
        });
    }
    const graph = graphAtRevision(await dependencies.deriveProjectGraph(observedAuthority), observedAuthority);
    return Object.freeze({
        ok: true,
        schema: 'project-authoring-result-v1',
        authority: observedAuthority,
        diff,
        graph,
    });
}
async function confirmedResultAfterMutation(authority, mutation, expectedDefinition, diff, dependencies) {
    try {
        return await resultAfterMutation(authority, mutation, expectedDefinition, diff, dependencies);
    }
    catch (error) {
        throw confirmedMutationFailure(error);
    }
}
export async function defineProjectDefinition(input, dependencies) {
    const projectRef = projectRefOf(input);
    requireDependencies(dependencies);
    const expectedRevision = exactRevision(input.expected_revision);
    const authority = await fencedAuthority(projectRef, expectedRevision, dependencies);
    const existingDefinition = await dependencies.readDefinition(authority);
    if (existingDefinition != null) {
        fail('PROJECT_AUTHORING_ALREADY_DEFINED', 'project.define requires an authority with no existing project definition', { project_ref: projectRef });
    }
    const definition = canonicalProjectDefinition(input.definition);
    if (definition.project_ref !== projectRef) {
        fail('PROJECT_AUTHORING_REQUEST_INVALID', 'definition.project_ref must match project_ref', { project_ref: projectRef, definition_project_ref: definition.project_ref });
    }
    const diff = Object.freeze({
        added: Object.freeze(definition.transitions.map((transition) => transition.id).sort()),
        changed: Object.freeze([]),
        removed: Object.freeze([]),
    });
    const mutation = await mutateProjectDefinition({
        project_ref: projectRef,
        repository: authority.repository,
        expected_revision: expectedRevision,
        derivation: authority.derivation,
        definition,
        diff,
    }, dependencies);
    return confirmedResultAfterMutation(authority, mutation, definition, diff, dependencies);
}
export async function amendProjectDefinition(input, dependencies) {
    const projectRef = projectRefOf(input);
    requireDependencies(dependencies);
    const expectedRevision = exactRevision(input.expected_revision);
    const authority = await fencedAuthority(projectRef, expectedRevision, dependencies);
    const currentDefinition = await dependencies.readDefinition(authority);
    const amendmentInput = await amendmentWithAuthoritativeHistory(projectRef, authority, currentDefinition, input.amendment, dependencies);
    const amendment = applyProjectDefinitionAmendment(currentDefinition, amendmentInput);
    if (typeof dependencies.validateAmendment === 'function') {
        await dependencies.validateAmendment(Object.freeze({
            project_ref: projectRef,
            authority,
            current_definition: canonicalProjectDefinition(currentDefinition),
            candidate_definition: amendment.definition,
            diff: amendment.diff,
        }));
    }
    const mutation = await mutateProjectDefinition({
        project_ref: projectRef,
        repository: authority.repository,
        expected_revision: expectedRevision,
        derivation: authority.derivation,
        definition: amendment.definition,
        diff: amendment.diff,
    }, dependencies);
    return confirmedResultAfterMutation(authority, mutation, amendment.definition, amendment.diff, dependencies);
}
