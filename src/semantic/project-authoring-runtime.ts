import { mayHaveMutated, mutationCertaintyFromEvidence } from './mutation-certainty.js';
import type { MutationCertainty } from './mutation-certainty.js';
import { applyProjectDefinitionAmendment, canonicalProjectDefinition } from './project-authoring.js';
import type { CanonicalProjectDefinition, ProjectDefinitionDiff } from './project-authoring.js';

export type ProjectAuthoringAuthority = Readonly<{
  project_ref: string;
  repository: string;
  revision: string;
  derivation: string;
}>;

export type ProjectAuthoringMutationRequest = Readonly<{
  project_ref: string;
  repository: string;
  expected_revision: string;
  derivation: string;
  definition: CanonicalProjectDefinition;
  diff: ProjectDefinitionDiff;
}>;

export type ProjectAuthoringRuntimeDependencies = Readonly<{
  resolveAuthority(input: Readonly<{ project_ref: string }>): Promise<ProjectAuthoringAuthority>;
  readDefinition(authority: ProjectAuthoringAuthority): Promise<unknown>;
  readProjectObservations?(authority: ProjectAuthoringAuthority): Promise<unknown>;
  mutateDefinition(request: ProjectAuthoringMutationRequest): Promise<Readonly<{ revision: string }>>;
  deriveProjectGraph(authority: ProjectAuthoringAuthority): Promise<unknown>;
}>;

export type ProjectAmendRequest = Readonly<{
  project_ref: string;
  expected_revision: string;
  amendment: Readonly<Record<string, unknown>>;
}>;

export type ProjectDefineRequest = Readonly<{
  project_ref: string;
  expected_revision: string;
  definition: Readonly<Record<string, unknown>>;
}>;

type ProjectAuthoringError = Error & {
  code?: string;
  details?: Readonly<Record<string, unknown>> | null;
  may_have_mutated?: boolean;
};

const SHA40 = /^[0-9a-f]{40}$/;

function fail(code: string, message: string, details: Readonly<Record<string, unknown>> | null = null): never {
  const error = new Error(message) as ProjectAuthoringError;
  error.code = code;
  error.details = details;
  throw error;
}

function exactRevision(value: unknown, field = 'expected_revision'): string {
  const revision = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!SHA40.test(revision)) {
    fail('PROJECT_AUTHORING_REQUEST_INVALID', `${field} must be an exact 40-character Git commit SHA`);
  }
  return revision;
}

function projectRefOf(input: { project_ref?: unknown }): string {
  const projectRef = typeof input?.project_ref === 'string' ? input.project_ref.trim() : '';
  if (!projectRef) fail('PROJECT_AUTHORING_REQUEST_INVALID', 'project_ref is required');
  return projectRef;
}

function requireDependencies(dependencies: ProjectAuthoringRuntimeDependencies): void {
  for (const name of ['resolveAuthority','readDefinition','mutateDefinition','deriveProjectGraph'] as const) {
    if (!dependencies || typeof dependencies[name] !== 'function') {
      fail('PROJECT_AUTHORING_REQUEST_INVALID', `${name} dependency is required`);
    }
  }
}

function confirmedMutationFailure(errorInput: unknown): ProjectAuthoringError {
  const error = errorInput instanceof Error
    ? errorInput as ProjectAuthoringError
    : new Error(String(errorInput || 'project authoring readback failed')) as ProjectAuthoringError;
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details
    : {};
  error.may_have_mutated = true;
  error.details = Object.freeze({ ...details, may_have_mutated:true });
  return error;
}

function mutationFailure(errorInput: unknown): ProjectAuthoringError {
  const error = errorInput instanceof Error
    ? errorInput as ProjectAuthoringError
    : new Error(String(errorInput || 'project authoring mutation failed')) as ProjectAuthoringError;
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details
    : {};
  const explicit = error.may_have_mutated ?? details.may_have_mutated;
  const fallback: MutationCertainty = explicit === undefined
    ? 'possible'
    : Boolean(explicit) ? 'possible' : 'none';
  const evidence = details.result ?? errorInput;
  const certainty = mutationCertaintyFromEvidence(evidence, fallback);
  error.may_have_mutated = mayHaveMutated(certainty);
  error.details = Object.freeze({
    ...details,
    may_have_mutated:error.may_have_mutated,
    mutation_certainty:certainty,
  });
  return error;
}

async function mutateProjectDefinition(
  request: ProjectAuthoringMutationRequest,
  dependencies: ProjectAuthoringRuntimeDependencies,
) {
  try {
    return await dependencies.mutateDefinition(request);
  } catch (error) {
    throw mutationFailure(error);
  }
}

async function fencedAuthority(projectRef: string, expectedRevision: string, dependencies: ProjectAuthoringRuntimeDependencies) {
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

function graphAtRevision(graphInput: unknown, authority: ProjectAuthoringAuthority) {
  if (!graphInput || typeof graphInput !== 'object' || Array.isArray(graphInput)) {
    fail('PROJECT_AUTHORING_READBACK_MISMATCH', 'derived project graph readback is invalid', {
      project_ref:authority.project_ref,
      expected_revision:authority.revision,
    });
  }
  const graph = graphInput as Readonly<Record<string, unknown>>;
  if (graph.revision == null) {
    return Object.freeze({ ...graph, revision:authority.revision });
  }
  const graphRevision = exactRevision(graph.revision, 'graph.revision');
  if (graphRevision !== authority.revision) {
    fail('PROJECT_AUTHORING_READBACK_MISMATCH', 'derived project graph does not match confirmed source revision', {
      project_ref:authority.project_ref,
      expected_revision:authority.revision,
      observed_revision:graphRevision,
    });
  }
  return graph;
}

function canonicalDefinitionsMatch(observedInput: unknown, expected: CanonicalProjectDefinition): boolean {
  if (observedInput == null) return false;
  try {
    return JSON.stringify(canonicalProjectDefinition(observedInput)) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

function refreshedAuthority(
  initial: ProjectAuthoringAuthority,
  observedInput: ProjectAuthoringAuthority,
  stagedRevision: string,
): ProjectAuthoringAuthority {
  const observedRevision = exactRevision(observedInput?.revision, 'authority.revision');
  if (observedInput?.project_ref !== initial.project_ref
      || observedInput?.repository !== initial.repository
      || observedInput?.derivation !== initial.derivation) {
    fail('PROJECT_AUTHORING_READBACK_MISMATCH', 'refreshed project authority identity changed after mutation', {
      project_ref:initial.project_ref,
      staged_revision:stagedRevision,
      expected_repository:initial.repository,
      observed_repository:observedInput?.repository ?? null,
      expected_derivation:initial.derivation,
      observed_derivation:observedInput?.derivation ?? null,
      observed_authority_revision:observedRevision,
    });
  }
  return Object.freeze({ ...observedInput, revision:observedRevision });
}

function amendmentTouchesExistingTransition(currentDefinitionInput: unknown, amendmentInput: Readonly<Record<string, unknown>>): boolean {
  const currentDefinition = canonicalProjectDefinition(currentDefinitionInput);
  const existingIds = new Set(currentDefinition.transitions.map((transition) => transition.id));
  const removed = Array.isArray(amendmentInput?.remove_transition_ids) ? amendmentInput.remove_transition_ids : [];
  const upserted = Array.isArray(amendmentInput?.upsert_transitions) ? amendmentInput.upsert_transitions : [];
  return removed.some((id) => typeof id === 'string' && existingIds.has(id.trim()))
    || upserted.some((transition) => transition && typeof transition === 'object' && !Array.isArray(transition)
      && typeof (transition as Record<string, unknown>).id === 'string'
      && existingIds.has(String((transition as Record<string, unknown>).id).trim()));
}

function confirmedTransitionIds(projectRef: string, observationsInput: unknown): readonly string[] {
  if (!Array.isArray(observationsInput)) {
    fail('PROJECT_AUTHORING_CONFIRMATION_HISTORY_INVALID', 'authoritative project confirmation history must be an array', { project_ref:projectRef });
  }
  const ids = new Set<string>();
  for (const observationInput of observationsInput) {
    if (!observationInput || typeof observationInput !== 'object' || Array.isArray(observationInput)) {
      fail('PROJECT_AUTHORING_CONFIRMATION_HISTORY_INVALID', 'authoritative project confirmation history contains an invalid observation', { project_ref:projectRef });
    }
    const observation = observationInput as Readonly<Record<string, unknown>>;
    const transitionId = typeof observation.transition_id === 'string' ? observation.transition_id.trim() : '';
    if (observation.schema !== 'project-transition-observation-v1'
        || observation.kind !== 'project_transition_confirmation'
        || observation.project_ref !== projectRef
        || observation.disposition !== 'completed'
        || !transitionId) {
      fail('PROJECT_AUTHORING_CONFIRMATION_HISTORY_INVALID', 'authoritative project confirmation history contains an invalid completed transition observation', { project_ref:projectRef });
    }
    ids.add(transitionId);
  }
  return Object.freeze([...ids].sort());
}

async function amendmentWithAuthoritativeHistory(
  projectRef: string,
  authority: ProjectAuthoringAuthority,
  currentDefinition: unknown,
  amendmentInput: Readonly<Record<string, unknown>>,
  dependencies: ProjectAuthoringRuntimeDependencies,
): Promise<Readonly<Record<string, unknown>>> {
  if (!amendmentTouchesExistingTransition(currentDefinition, amendmentInput)) return amendmentInput;
  if (typeof dependencies.readProjectObservations !== 'function') {
    fail('PROJECT_AUTHORING_CONFIRMATION_HISTORY_UNAVAILABLE', 'project amendment requires authoritative confirmation history before changing an existing transition', { project_ref:projectRef });
  }
  const ids = confirmedTransitionIds(projectRef, await dependencies.readProjectObservations(authority));
  return Object.freeze({ ...amendmentInput, confirmed_transition_ids:ids });
}

async function resultAfterMutation(
  authority: ProjectAuthoringAuthority,
  mutation: Readonly<{ revision: string }>,
  expectedDefinition: CanonicalProjectDefinition,
  diff: ProjectDefinitionDiff,
  dependencies: ProjectAuthoringRuntimeDependencies,
) {
  const stagedRevision = exactRevision(mutation?.revision, 'mutation.revision');
  const observedAuthority = refreshedAuthority(
    authority,
    await dependencies.resolveAuthority({ project_ref:authority.project_ref }),
    stagedRevision,
  );
  const observedDefinition = await dependencies.readDefinition(observedAuthority);
  if (!canonicalDefinitionsMatch(observedDefinition, expectedDefinition)) {
    fail('PROJECT_AUTHORING_READBACK_MISMATCH', 'project authoring mutation is not observable through refreshed project authority', {
      project_ref:authority.project_ref,
      staged_revision:stagedRevision,
      observed_authority_revision:observedAuthority.revision,
    });
  }
  const graph = graphAtRevision(await dependencies.deriveProjectGraph(observedAuthority), observedAuthority);
  return Object.freeze({
    ok:true as const,
    schema:'project-authoring-result-v1' as const,
    authority:observedAuthority,
    diff,
    graph,
  });
}

async function confirmedResultAfterMutation(
  authority: ProjectAuthoringAuthority,
  mutation: Readonly<{ revision: string }>,
  expectedDefinition: CanonicalProjectDefinition,
  diff: ProjectDefinitionDiff,
  dependencies: ProjectAuthoringRuntimeDependencies,
) {
  try {
    return await resultAfterMutation(authority, mutation, expectedDefinition, diff, dependencies);
  } catch (error) {
    throw confirmedMutationFailure(error);
  }
}

export async function defineProjectDefinition(
  input: ProjectDefineRequest,
  dependencies: ProjectAuthoringRuntimeDependencies,
) {
  const projectRef = projectRefOf(input);
  requireDependencies(dependencies);
  const expectedRevision = exactRevision(input.expected_revision);
  const authority = await fencedAuthority(projectRef, expectedRevision, dependencies);
  const existingDefinition = await dependencies.readDefinition(authority);
  if (existingDefinition != null) {
    fail('PROJECT_AUTHORING_ALREADY_DEFINED', 'project.define requires an authority with no existing project definition', { project_ref:projectRef });
  }
  const definition = canonicalProjectDefinition(input.definition);
  if (definition.project_ref !== projectRef) {
    fail('PROJECT_AUTHORING_REQUEST_INVALID', 'definition.project_ref must match project_ref', { project_ref:projectRef, definition_project_ref:definition.project_ref });
  }
  const diff: ProjectDefinitionDiff = Object.freeze({
    added:Object.freeze(definition.transitions.map((transition) => transition.id).sort()),
    changed:Object.freeze([]),
    removed:Object.freeze([]),
  });
  const mutation = await mutateProjectDefinition({
    project_ref:projectRef,
    repository:authority.repository,
    expected_revision:expectedRevision,
    derivation:authority.derivation,
    definition,
    diff,
  }, dependencies);
  return confirmedResultAfterMutation(authority, mutation, definition, diff, dependencies);
}

export async function amendProjectDefinition(
  input: ProjectAmendRequest,
  dependencies: ProjectAuthoringRuntimeDependencies,
) {
  const projectRef = projectRefOf(input);
  requireDependencies(dependencies);
  const expectedRevision = exactRevision(input.expected_revision);
  const authority = await fencedAuthority(projectRef, expectedRevision, dependencies);
  const currentDefinition = await dependencies.readDefinition(authority);
  const amendmentInput = await amendmentWithAuthoritativeHistory(projectRef, authority, currentDefinition, input.amendment, dependencies);
  const amendment = applyProjectDefinitionAmendment(currentDefinition, amendmentInput);
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
