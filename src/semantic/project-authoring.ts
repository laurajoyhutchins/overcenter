import { normalizeProjectExecutor } from './project-graph-contracts.js';
import type { Executor } from './project-graph-types.js';

export type ProjectTransitionIntent = {
  readonly id: string;
  readonly priority: number;
  readonly requires: readonly string[];
  readonly executor: Executor;
};

export type ProjectDefinitionIntent = {
  readonly project_ref: string;
  readonly transitions: readonly ProjectTransitionIntent[];
};

type ProjectAuthoringFail = (code: string, message: string, details?: unknown) => never;

function fail(code: string, message: string, details?: unknown): never {
  const error = new Error(message) as Error & { code?: string; details?: unknown };
  error.code = code;
  error.details = details;
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, supported: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !supported.includes(key)).sort();
  if (unknown.length) fail('PROJECT_DEFINITION_INTENT_INVALID', `${field} contains unsupported fields`, { field, unknown });
}

function text(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('PROJECT_DEFINITION_INTENT_INVALID', `${field} must be a non-empty string`, { field });
  return normalized;
}

function transition(raw: unknown, index: number): ProjectTransitionIntent {
  const field = `transitions[${index}]`;
  if (!isRecord(raw)) fail('PROJECT_DEFINITION_INTENT_INVALID', `${field} must be an object`, { field });
  exactKeys(raw, ['executor', 'id', 'priority', 'requires'], field);
  const id = text(raw.id, `${field}.id`);
  if (!Number.isInteger(raw.priority)) {
    fail('PROJECT_DEFINITION_INTENT_INVALID', `${field}.priority must be an integer`, { field: `${field}.priority` });
  }
  if (!Array.isArray(raw.requires)) {
    fail('PROJECT_DEFINITION_INTENT_INVALID', `${field}.requires must be an array`, { field: `${field}.requires` });
  }
  const requires = raw.requires.map((value, requirementIndex) => text(value, `${field}.requires[${requirementIndex}]`));
  if (new Set(requires).size !== requires.length) {
    fail('PROJECT_DEFINITION_INTENT_INVALID', `${field}.requires contains duplicates`, { id });
  }
  if (requires.includes(id)) {
    fail('PROJECT_DEFINITION_INTENT_INVALID', `${field}.requires cannot contain its own transition id`, { id });
  }
  return Object.freeze({
    id,
    priority: raw.priority as number,
    requires: Object.freeze(requires),
    executor: normalizeProjectExecutor(raw.executor, id, fail as ProjectAuthoringFail),
  });
}

function assertGraphReferences(transitions: readonly ProjectTransitionIntent[]): void {
  const ids = new Set(transitions.map((item) => item.id));
  if (ids.size !== transitions.length) fail('PROJECT_DEFINITION_INTENT_INVALID', 'transition ids must be unique');
  for (const item of transitions) {
    const missing = item.requires.filter((dependency) => !ids.has(dependency)).sort();
    if (missing.length) {
      fail('PROJECT_DEFINITION_INTENT_INVALID', 'transition dependency references a missing transition', { transition_id: item.id, missing });
    }
  }

  const byId = new Map(transitions.map((item) => [item.id, item]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      fail('PROJECT_DEFINITION_INTENT_CYCLE', 'project definition intent must be acyclic', { cycle: [...path.slice(start), id] });
    }
    visiting.add(id);
    path.push(id);
    for (const dependency of byId.get(id)?.requires ?? []) visit(dependency);
    path.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...ids].sort()) visit(id);
}

export function normalizeProjectDefinitionIntent(raw: unknown): ProjectDefinitionIntent {
  if (!isRecord(raw)) fail('PROJECT_DEFINITION_INTENT_INVALID', 'project definition intent must be an object');
  exactKeys(raw, ['project_ref', 'transitions'], 'project definition intent');
  if (!Array.isArray(raw.transitions)) {
    fail('PROJECT_DEFINITION_INTENT_INVALID', 'transitions must be an array', { field: 'transitions' });
  }
  const transitions = raw.transitions.map(transition);
  assertGraphReferences(transitions);
  return Object.freeze({
    project_ref: text(raw.project_ref, 'project_ref'),
    transitions: Object.freeze(transitions),
  });
}