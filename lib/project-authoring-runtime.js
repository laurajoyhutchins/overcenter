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
  if (!projectRef) fail('PROJECT_AUTHORING_REQUEST_INVALID', 'project_ref is required');
  return projectRef;
}

function requireDependencies(dependencies) {
  for (const name of ['resolveAuthority','readDefinition','mutateDefinition','deriveProjectGraph']) {
    if (!dependencies || typeof dependencies[name] !== 'function') {
      fail('PROJECT_AUTHORING_REQUEST_INVALID', `${name} dependency is required`);
    }
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

async function resultAfterMutation(authority, mutation, diff, dependencies) {
  const resultingRevision = exactRevision(mutation?.revision, 'mutation.revision');
  const resultingAuthority = Object.freeze({ ...authority, revision: resultingRevision });
  const graph = await dependencies.deriveProjectGraph(resultingAuthority);
  const graphRevision = exactRevision(graph?.revision, 'graph.revision');
  if (graphRevision !== resultingRevision) {
    fail('PROJECT_AUTHORING_READBACK_MISMATCH', 'derived project graph does not match confirmed source revision', {
      project_ref:authority.project_ref,
      expected_revision:resultingRevision,
      observed_revision:graphRevision,
    });
  }
  return Object.freeze({
    schema:'project-authoring-result-v1',
    authority:resultingAuthority,
    diff,
    graph,
  });
}

export async function defineProjectDefinition(input, dependencies) {
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
  const diff = Object.freeze({
    added:Object.freeze(definition.transitions.map((transition) => transition.id).sort()),
    changed:Object.freeze([]),
    removed:Object.freeze([]),
  });
  const mutation = await dependencies.mutateDefinition({
    project_ref:projectRef,
    repository:authority.repository,
    expected_revision:expectedRevision,
    derivation:authority.derivation,
    definition,
    diff,
  });
  return resultAfterMutation(authority, mutation, diff, dependencies);
}

export async function amendProjectDefinition(input, dependencies) {
  const projectRef = projectRefOf(input);
  requireDependencies(dependencies);
  const expectedRevision = exactRevision(input.expected_revision);
  const authority = await fencedAuthority(projectRef, expectedRevision, dependencies);
  const currentDefinition = await dependencies.readDefinition(authority);
  const amendment = applyProjectDefinitionAmendment(currentDefinition, input.amendment);
  const mutation = await dependencies.mutateDefinition({
    project_ref: projectRef,
    repository: authority.repository,
    expected_revision: expectedRevision,
    derivation: authority.derivation,
    definition: amendment.definition,
    diff: amendment.diff,
  });
  return resultAfterMutation(authority, mutation, amendment.diff, dependencies);
}