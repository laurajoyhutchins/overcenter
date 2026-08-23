const STAGES = ['ENABLE', 'ACQUIRE', 'EXECUTE', 'COMMIT', 'CONFIRM'];
const CONDITIONS = ['NOMINAL', 'HOLD', 'FAULT', 'INDETERMINATE', 'OPERATOR_HOLD'];
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

function normalizeCondition(value) {
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
export const LEGACY_LANE_BY_STAGE = Object.freeze({
  ENABLE: null,
  ACQUIRE: 'lane:source-implementation',
  EXECUTE: 'lane:repo-implementation',
  COMMIT: 'lane:integration',
  CONFIRM: 'lane:verification',
});
export const STAGE_BY_LEGACY_LANE = Object.freeze(Object.fromEntries(
  Object.entries(LEGACY_LANE_BY_STAGE).filter(([, lane]) => lane).map(([stage, lane]) => [lane, stage]),
));

export function resolveWorkLifecycle(input = {}) {
  const currentStage = normalizeStage(input.current_stage);
  const condition = normalizeCondition(input.condition);
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
  const condition = normalizeCondition(input.condition);
  if (condition !== 'NOMINAL') fail('RECOVERY_NOT_RESET', 're-entry requires the off-nominal condition to be reset to NOMINAL', { condition });
  return resolveWorkLifecycle(input);
}

export function legacyProjectionForStage(stage) {
  const normalized = normalizeStage(stage, 'stage');
  const lane = LEGACY_LANE_BY_STAGE[normalized];
  if (normalized === 'ENABLE') return Object.freeze({ state: 'Todo', lane: null, participant: 'enable' });
  return Object.freeze({ state: 'Todo', lane, participant: normalized.toLowerCase() });
}
