import { OPERATING_CONDITIONS as SEMANTIC_OPERATING_CONDITIONS, PRODUCTIVE_STAGES as SEMANTIC_PRODUCTIVE_STAGES } from './execution-lifecycle-contracts.js';

const STAGES = [...SEMANTIC_PRODUCTIVE_STAGES];
const CONDITIONS = [...SEMANTIC_OPERATING_CONDITIONS];
const STAGE_SET = new Set(STAGES);
const CONDITION_SET = new Set(CONDITIONS);
const ORDER = new Map(STAGES.map((stage, index) => [stage, index]));

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function normalizeStage(value, field = 'current_stage') {
  const stage = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!STAGE_SET.has(stage)) fail('INVALID_STAGE', `${field} must be a productive lifecycle stage`, { field, value: value ?? null });
  return stage;
}

export function normalizeOperatingCondition(value) {
  const condition = value == null ? 'NOMINAL' : String(value).trim().toUpperCase();
  if (!CONDITION_SET.has(condition)) fail('INVALID_CONDITION', 'condition must be a known operating condition', { condition: value ?? null });
  return condition;
}

function normalizeResponsibility(stage, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('INVALID_RESPONSIBILITY', `${stage} responsibility must be an object`, { stage });
  }
  const applicable = raw.applicable !== false;
  const satisfied = raw.satisfied === true;
  if (!applicable && satisfied) return { stage, applicable: false, satisfied: true };
  return { stage, applicable, satisfied };
}

function normalizeResponsibilities(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('INVALID_RESPONSIBILITIES', 'responsibilities must be an object');
  const unknown = Object.keys(raw).filter((key) => !STAGE_SET.has(String(key).toUpperCase()));
  if (unknown.length) fail('INVALID_RESPONSIBILITIES', 'responsibilities contains unknown stages', { unknown: unknown.sort() });
  return STAGES.map((stage) => normalizeResponsibility(stage, raw[stage] ?? raw[stage.toLowerCase()]));
}

function transitionKind(current, target) {
  if (target === 'DONE') return 'complete';
  if (current === target) return 'stay';
  const delta = ORDER.get(target) - ORDER.get(current);
  if (delta < 0) return 'feedback';
  if (delta === 1) return 'forward';
  return 'forward_bypass';
}

export const PRODUCTIVE_STAGES = Object.freeze([...STAGES]);
export const OPERATING_CONDITIONS = Object.freeze([...CONDITIONS]);
export const STAGE_COMMANDS = Object.freeze({
  ENABLE: 'work.enable',
  ACQUIRE: 'work.acquire',
  EXECUTE: 'work.execute',
  COMMIT: 'work.commit',
  CONFIRM: 'work.confirm',
});

export function resolveWorkLifecycle(input = {}) {
  const currentStage = normalizeStage(input.current_stage);
  const condition = normalizeOperatingCondition(input.condition);
  const responsibilities = normalizeResponsibilities(input.responsibilities);
  if (condition !== 'NOMINAL') {
    return Object.freeze({
      current_stage: currentStage,
      next_stage: currentStage,
      condition,
      transition_kind: 'off_nominal',
      command: STAGE_COMMANDS[currentStage],
      complete: false,
    });
  }
  const unresolved = responsibilities.find((entry) => entry.applicable && !entry.satisfied) || null;
  const nextStage = unresolved?.stage || 'DONE';
  return Object.freeze({
    current_stage: currentStage,
    next_stage: nextStage,
    condition,
    transition_kind: transitionKind(currentStage, nextStage),
    command: nextStage === 'DONE' ? null : STAGE_COMMANDS[nextStage],
    complete: nextStage === 'DONE',
  });
}

export function resolveLifecycleAfterRecovery(input = {}) {
  const condition = normalizeOperatingCondition(input.condition);
  if (condition !== 'NOMINAL') fail('RECOVERY_NOT_RESET', 're-entry requires the off-nominal condition to be reset to NOMINAL', { condition });
  return resolveWorkLifecycle(input);
}

export function successfulStageResponsibilities(stage) {
  const normalized = normalizeStage(stage, 'stage');
  const completedIndex = ORDER.get(normalized);
  return Object.freeze(Object.fromEntries(STAGES.map((candidate, index) => [
    candidate,
    Object.freeze({ applicable: true, satisfied: index <= completedIndex }),
  ])));
}

export function resolveCompletedStage(input = {}) {
  const currentStage = normalizeStage(input.current_stage);
  const lifecycleFacts = input.lifecycle_facts;
  if (lifecycleFacts !== undefined && lifecycleFacts !== null) {
    if (!lifecycleFacts || typeof lifecycleFacts !== 'object' || Array.isArray(lifecycleFacts)) {
      fail('INVALID_LIFECYCLE_FACTS', 'lifecycle_facts must be an object');
    }
    const unknown = Object.keys(lifecycleFacts).filter((key) => !['condition', 'responsibilities'].includes(key));
    if (unknown.length) fail('INVALID_LIFECYCLE_FACTS', 'lifecycle_facts contains unsupported fields', { unknown: unknown.sort() });
  }
  return resolveWorkLifecycle({
    current_stage: currentStage,
    condition: lifecycleFacts?.condition ?? 'NOMINAL',
    responsibilities: lifecycleFacts?.responsibilities ?? successfulStageResponsibilities(currentStage),
  });
}