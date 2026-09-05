import { normalizeProjectExecutionIntent, normalizeProjectExecutor, normalizeProjectPhaseBindings } from './project-graph-contracts.js';
import { normalizeProjectVersionImpact } from './project-version-impact.js';
import type { Executor, PhaseBindings, ProjectExecutionIntent } from './project-graph-types.js';
import type { ProjectVersionImpact } from './project-version-impact.js';

export const PROJECT_DEFINITION_SCHEMA = 'overcenter-project-definition-v1' as const;

type Fail = (message: string, details?: unknown) => never;

type CanonicalTransition = Readonly<{
  id: string;
  priority: number;
  requires: readonly string[];
  executor: Executor;
  execution_intent?: ProjectExecutionIntent;
  version_impact?: ProjectVersionImpact;
  phase_bindings?: PhaseBindings;
}>;

export type CanonicalProjectDefinition = Readonly<{
  schema: typeof PROJECT_DEFINITION_SCHEMA;
  project_ref: string;
  transitions: readonly CanonicalTransition[];
}>;

export type ProjectDefinitionDiff = Readonly<{
  added: readonly string[];
  changed: readonly string[];
  removed: readonly string[];
}>;

function fail(message: string, details: unknown = null): never {
  const error = new Error(message);
  Object.assign(error, { code:'PROJECT_DEFINITION_INVALID', details });
  throw error;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be an object`, { field });
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(`${field} must be a non-empty string`, { field });
  return normalized;
}

function exactKeys(input: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length) fail(`${field} contains unsupported fields`, { field, unknown });
}

function normalizeTransition(raw: unknown, index: number): CanonicalTransition {
  const input = record(raw, `transitions[${index}]`);
  exactKeys(input, ['id','priority','requires','executor','execution_intent','version_impact','phase_bindings'], `transitions[${index}]`);
  const id = text(input.id, `transitions[${index}].id`);
  if (!Number.isInteger(input.priority)) fail(`transitions[${index}].priority must be an integer`, { id });
  if (!Array.isArray(input.requires)) fail(`transitions[${index}].requires must be an array`, { id });
  const requires = input.requires.map((value, requirementIndex) => text(value, `transitions[${index}].requires[${requirementIndex}]`));
  if (new Set(requires).size !== requires.length) fail('transition requirements must be unique', { id });
  if (requires.includes(id)) fail('transition cannot depend on itself', { id });
  const contractFail: Fail = (message, details) => fail(message, details);
  const executor = normalizeProjectExecutor(input.executor, id, (_code, message, details) => contractFail(message, details));
  const executionIntent = normalizeProjectExecutionIntent(input.execution_intent, id, (_code, message, details) => contractFail(message, details));
  const versionImpact = normalizeProjectVersionImpact(input.version_impact, id, (_code, message, details) => contractFail(message, details));
  const phaseBindings = normalizeProjectPhaseBindings(input.phase_bindings, id, (_code, message, details) => contractFail(message, details));
  return Object.freeze({
    id,
    priority: input.priority as number,
    requires: Object.freeze([...requires].sort()),
    executor,
    ...(executionIntent ? { execution_intent:executionIntent } : {}),
    ...(versionImpact ? { version_impact:versionImpact } : {}),
    ...(Object.keys(phaseBindings).length ? { phase_bindings:phaseBindings } : {}),
  });
}

function validateGraph(transitions: readonly CanonicalTransition[]): void {
  const byId = new Map<string, CanonicalTransition>();
  for (const transition of transitions) {
    if (byId.has(transition.id)) fail('transition ids must be unique', { id:transition.id });
    byId.set(transition.id, transition);
  }
  for (const transition of transitions) {
    for (const dependency of transition.requires) {
      if (!byId.has(dependency)) fail('missing dependency in candidate project definition', { transition_id:transition.id, dependency });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      fail('project definition dependency cycle detected', { cycle:[...path.slice(start), id] });
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of byId.get(id)?.requires ?? []) visit(dependency);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
}

function structuralIdentity(transition: CanonicalTransition): string {
  return JSON.stringify(transition);
}

export function canonicalProjectDefinition(raw: unknown): CanonicalProjectDefinition {
  const input = record(raw, 'definition');
  exactKeys(input, ['schema','project_ref','transitions'], 'definition');
  if (input.schema !== PROJECT_DEFINITION_SCHEMA) fail('unsupported project definition schema', { schema:input.schema ?? null });
  const projectRef = text(input.project_ref, 'definition.project_ref');
  if (!Array.isArray(input.transitions) || input.transitions.length === 0) fail('definition.transitions must be a non-empty array');
  const transitions = input.transitions.map(normalizeTransition).sort((left, right) => left.id.localeCompare(right.id));
  validateGraph(transitions);
  return Object.freeze({ schema:PROJECT_DEFINITION_SCHEMA, project_ref:projectRef, transitions:Object.freeze(transitions) });
}

export function applyProjectDefinitionAmendment(base: unknown, rawAmendment: unknown): Readonly<{ definition:CanonicalProjectDefinition; diff:ProjectDefinitionDiff }> {
  const definition = canonicalProjectDefinition(base);
  const amendment = record(rawAmendment, 'amendment');
  exactKeys(amendment, ['upsert_transitions','remove_transition_ids','confirmed_transition_ids'], 'amendment');
  const upsertsRaw = amendment.upsert_transitions ?? [];
  const removalsRaw = amendment.remove_transition_ids ?? [];
  const confirmedRaw = amendment.confirmed_transition_ids ?? [];
  if (!Array.isArray(upsertsRaw) || !Array.isArray(removalsRaw) || !Array.isArray(confirmedRaw)) fail('amendment transition collections must be arrays');
  const upserts = upsertsRaw.map(normalizeTransition);
  const removals = removalsRaw.map((value, index) => text(value, `amendment.remove_transition_ids[${index}]`));
  const confirmed = new Set(confirmedRaw.map((value, index) => text(value, `amendment.confirmed_transition_ids[${index}]`)));
  if (new Set(upserts.map((transition) => transition.id)).size !== upserts.length) fail('amendment upsert transition ids must be unique');
  if (new Set(removals).size !== removals.length) fail('amendment removal ids must be unique');
  const upsertIds = new Set(upserts.map((transition) => transition.id));
  const contradictory = removals.filter((id) => upsertIds.has(id));
  if (contradictory.length) fail('transition cannot be removed and upserted in the same amendment', { transition_ids:contradictory.sort() });

  const before = new Map(definition.transitions.map((transition) => [transition.id, transition]));
  const candidate = new Map(before);
  for (const id of removals) candidate.delete(id);
  for (const transition of upserts) {
    const prior = before.get(transition.id);
    if (prior && confirmed.has(transition.id) && structuralIdentity(prior) !== structuralIdentity(transition)) {
      fail('confirmed transition meaning cannot be rewritten in place', { transition_id:transition.id });
    }
    candidate.set(transition.id, transition);
  }
  for (const id of removals) {
    if (confirmed.has(id)) fail('confirmed transition cannot be removed', { transition_id:id });
  }

  const nextTransitions = [...candidate.values()].sort((left, right) => left.id.localeCompare(right.id));
  validateGraph(nextTransitions);
  const next: CanonicalProjectDefinition = Object.freeze({
    schema:PROJECT_DEFINITION_SCHEMA,
    project_ref:definition.project_ref,
    transitions:Object.freeze(nextTransitions),
  });
  const after = new Map(next.transitions.map((transition) => [transition.id, transition]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.keys()].filter((id) => before.has(id) && structuralIdentity(before.get(id)!) !== structuralIdentity(after.get(id)!)).sort();
  return Object.freeze({
    definition:next,
    diff:Object.freeze({ added:Object.freeze(added), changed:Object.freeze(changed), removed:Object.freeze(removed) }),
  });
}
