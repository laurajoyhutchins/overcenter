import { CANONICAL_COMMANDS } from './canonical-commands.js';
import type { CanonicalCommand } from './canonical-commands.js';
import type {
  Executor,
  JsonValue,
  PhaseBinding,
  ProjectExecutionIntent,
  PhaseBindings,
  PhaseInputSource,
  ProjectBindingPhase,
} from './project-graph-types.js';

export type ProjectGraphFail = (code: string, message: string, details?: unknown) => never;

const CANONICAL_COMMAND_SET: ReadonlySet<string> = new Set(CANONICAL_COMMANDS);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string, fail: ProjectGraphFail): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('INVALID_PROJECT_GRAPH', `${field} must be a non-empty string`, { field, value: value ?? null });
  return normalized;
}

function boundedText(value: unknown, field: string, max: number, fail: ProjectGraphFail): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) {
    fail('INVALID_PROJECT_GRAPH', `${field} must be a non-empty string no longer than ${max} characters`, { field, value: value ?? null, max });
  }
  return normalized;
}

function canonicalCommand(value: unknown, field: string, fail: ProjectGraphFail): CanonicalCommand {
  const command = requiredText(value, field, fail);
  if (!CANONICAL_COMMAND_SET.has(command)) {
    fail('INVALID_PROJECT_GRAPH', `${field} must name a canonical Overcenter command`, { field, command });
  }
  return command as CanonicalCommand;
}

export function normalizeProjectExecutor(raw: unknown, nodeId: string, fail: ProjectGraphFail): Executor {
  if (!isRecord(raw)) fail('INVALID_PROJECT_GRAPH', 'executor must be an object', { node_id: nodeId });
  const kind = requiredText(raw.kind, 'executor.kind', fail).toLowerCase();
  if (kind === 'operator') {
    return Object.freeze({ kind, command: canonicalCommand(raw.command, 'executor.command', fail) });
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

export function normalizeProjectExecutionIntent(raw: unknown, nodeId: string, fail: ProjectGraphFail): ProjectExecutionIntent | undefined {
  if (raw == null) return undefined;
  if (!isRecord(raw)) fail('INVALID_PROJECT_GRAPH', 'execution_intent must be an object', { node_id: nodeId });
  const unknown = Object.keys(raw).filter((key) => !['schema', 'desired_outcome', 'acceptance_evidence', 'source_ref'].includes(key)).sort();
  if (unknown.length) fail('INVALID_PROJECT_GRAPH', 'execution_intent contains unsupported fields', { node_id: nodeId, unknown });
  if (raw.schema !== 'project-execution-intent-v1') {
    fail('INVALID_PROJECT_GRAPH', 'execution_intent.schema is unsupported', { node_id: nodeId, schema: raw.schema ?? null });
  }
  const desiredOutcome = boundedText(raw.desired_outcome, 'execution_intent.desired_outcome', 4096, fail);
  if (!Array.isArray(raw.acceptance_evidence) || raw.acceptance_evidence.length === 0 || raw.acceptance_evidence.length > 16) {
    fail('INVALID_PROJECT_GRAPH', 'execution_intent.acceptance_evidence must contain between 1 and 16 requirements', { node_id: nodeId });
  }
  const acceptanceEvidence = raw.acceptance_evidence.map((entry, index) => {
    if (!isRecord(entry)) fail('INVALID_PROJECT_GRAPH', 'execution_intent acceptance evidence requirement must be an object', { node_id: nodeId, index });
    const entryUnknown = Object.keys(entry).filter((key) => !['kind', 'requirement'].includes(key)).sort();
    if (entryUnknown.length) fail('INVALID_PROJECT_GRAPH', 'execution_intent acceptance evidence requirement contains unsupported fields', { node_id: nodeId, index, unknown: entryUnknown });
    return Object.freeze({
      kind: boundedText(entry.kind, `execution_intent.acceptance_evidence[${index}].kind`, 128, fail),
      requirement: boundedText(entry.requirement, `execution_intent.acceptance_evidence[${index}].requirement`, 2048, fail),
    });
  });
  const evidenceKeys = acceptanceEvidence.map((entry) => JSON.stringify(entry));
  if (new Set(evidenceKeys).size !== evidenceKeys.length) {
    fail('INVALID_PROJECT_GRAPH', 'execution_intent.acceptance_evidence contains duplicates', { node_id: nodeId });
  }
  const sourceRef = raw.source_ref == null ? undefined : boundedText(raw.source_ref, 'execution_intent.source_ref', 512, fail);
  return Object.freeze({
    schema:'project-execution-intent-v1',
    desired_outcome:desiredOutcome,
    acceptance_evidence:Object.freeze(acceptanceEvidence),
    ...(sourceRef ? { source_ref:sourceRef } : {}),
  });
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
      primitive: canonicalCommand(rawBinding.primitive, `phase_bindings.${phase}.primitive`, fail),
      evidence: Object.freeze([...evidence]),
      input: normalizeProjectPhaseInput(rawBinding.input, nodeId, phase, fail),
    });
  }
  return Object.freeze(normalized);
}