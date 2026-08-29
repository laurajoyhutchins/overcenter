import type {
  Executor,
  JsonValue,
  PhaseBinding,
  PhaseBindings,
  PhaseInputSource,
  ProjectBindingPhase,
} from './project-graph-types.js';

export type ProjectGraphFail = (code: string, message: string, details?: unknown) => never;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, fail: ProjectGraphFail): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('INVALID_PROJECT_GRAPH', `${field} must be a non-empty string`, { field, value: value ?? null });
  return normalized;
}

export function normalizeProjectExecutor(raw: unknown, nodeId: string, fail: ProjectGraphFail): Executor {
  if (!isRecord(raw)) fail('INVALID_PROJECT_GRAPH', 'executor must be an object', { node_id: nodeId });
  const kind = requiredText(raw.kind, 'executor.kind', fail).toLowerCase();
  if (kind === 'operator') {
    return Object.freeze({ kind, command: requiredText(raw.command, 'executor.command', fail) });
  }
  if (kind === 'agent') {
    return Object.freeze({
      kind,
      role: requiredText(raw.role, 'executor.role', fail),
      skill: requiredText(raw.skill, 'executor.skill', fail),
    });
  }
  return fail('INVALID_PROJECT_GRAPH', 'executor.kind must be operator or agent', { node_id: nodeId, kind });
}

function normalizeProjectLiteral(value: unknown, field: string, fail: ProjectGraphFail): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => normalizeProjectLiteral(entry, `${field}[${index}]`, fail)));
  }
  if (isRecord(value)) {
    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        fail('INVALID_PROJECT_GRAPH', 'phase binding literal contains an unsafe key', { field, key });
      }
      normalized[key] = normalizeProjectLiteral(value[key], `${field}.${key}`, fail);
    }
    return Object.freeze(normalized);
  }
  return fail('INVALID_PROJECT_GRAPH', 'phase binding literal must be JSON-compatible', { field });
}

export function normalizeProjectPhaseInput(
  raw: unknown,
  nodeId: string,
  phase: string,
  fail: ProjectGraphFail,
): Readonly<Record<string, PhaseInputSource>> {
  if (raw == null) return Object.freeze({});
  if (!isRecord(raw)) {
    fail('INVALID_PROJECT_GRAPH', 'phase binding input must be an object', { node_id: nodeId, phase });
  }
  const normalized: Record<string, PhaseInputSource> = {};
  for (const [field, rawSource] of Object.entries(raw)) {
    const semanticField = requiredText(field, `phase_bindings.${phase}.input field`, fail);
    if (!isRecord(rawSource)) {
      fail('INVALID_PROJECT_GRAPH', 'phase binding input source must be an object', { node_id: nodeId, phase, field: semanticField });
    }
    const keys = Object.keys(rawSource).sort();
    if (keys.length !== 1 || !['from', 'literal'].includes(keys[0] ?? '')) {
      fail('INVALID_PROJECT_GRAPH', 'phase binding input source must declare exactly one of from or literal', { node_id: nodeId, phase, field: semanticField, keys });
    }
    if (keys[0] === 'literal') {
      normalized[semanticField] = Object.freeze({
        literal: normalizeProjectLiteral(rawSource.literal, `phase_bindings.${phase}.input.${semanticField}.literal`, fail),
      });
      continue;
    }
    const from = requiredText(rawSource.from, `phase_bindings.${phase}.input.${semanticField}.from`, fail);
    const segments = from.split('.');
    const safeSegments = segments.every((segment) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) &&
      !['__proto__', 'prototype', 'constructor'].includes(segment)
    );
    const allowedRoot = segments[0] === 'transition' || (segments[0] === 'context' && segments[1] === 'phases');
    if (!safeSegments || !allowedRoot || segments.length < 2) {
      fail('INVALID_PROJECT_GRAPH', 'phase binding input reference must target transition or prior phase evidence', { node_id: nodeId, phase, field: semanticField, from });
    }
    normalized[semanticField] = Object.freeze({ from });
  }
  return Object.freeze(normalized);
}

function isProjectBindingPhase(value: string): value is ProjectBindingPhase {
  return value === 'ACQUIRE' || value === 'COMMIT' || value === 'CONFIRM';
}

export function normalizeProjectPhaseBindings(raw: unknown, nodeId: string, fail: ProjectGraphFail): PhaseBindings {
  if (raw == null) return Object.freeze({});
  if (!isRecord(raw)) {
    fail('INVALID_PROJECT_GRAPH', 'phase_bindings must be an object', { node_id: nodeId });
  }
  const normalized: Partial<Record<ProjectBindingPhase, PhaseBinding>> = {};
  for (const [rawPhase, rawBinding] of Object.entries(raw)) {
    const phase = String(rawPhase || '').trim().toUpperCase();
    if (!isProjectBindingPhase(phase)) {
      fail('INVALID_PROJECT_GRAPH', 'phase_bindings supports ACQUIRE, COMMIT, and CONFIRM only', { node_id: nodeId, phase: rawPhase });
    }
    if (normalized[phase]) {
      fail('INVALID_PROJECT_GRAPH', 'phase_bindings contains duplicate normalized phases', { node_id: nodeId, phase });
    }
    if (!isRecord(rawBinding)) {
      fail('INVALID_PROJECT_GRAPH', 'phase binding must be an object', { node_id: nodeId, phase });
    }
    const unknown = Object.keys(rawBinding).filter((key) => !['primitive', 'evidence', 'input'].includes(key)).sort();
    if (unknown.length) {
      fail('INVALID_PROJECT_GRAPH', 'phase binding contains unsupported fields', { node_id: nodeId, phase, unknown });
    }
    const rawEvidence = rawBinding.evidence;
    if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) {
      fail('INVALID_PROJECT_GRAPH', 'phase binding evidence must be a non-empty array', { node_id: nodeId, phase });
    }
    const evidence = rawEvidence.map((value, index) =>
      requiredText(value, `phase_bindings.${phase}.evidence[${index}]`, fail)
    );
    if (new Set(evidence).size !== evidence.length) {
      fail('INVALID_PROJECT_GRAPH', 'phase binding evidence contains duplicates', { node_id: nodeId, phase });
    }
    normalized[phase] = Object.freeze({
      primitive: requiredText(rawBinding.primitive, `phase_bindings.${phase}.primitive`, fail),
      evidence: Object.freeze([...evidence]),
      input: normalizeProjectPhaseInput(rawBinding.input, nodeId, phase, fail),
    });
  }
  return Object.freeze(normalized);
}