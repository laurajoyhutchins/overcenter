export const CODEX_ALLOWANCE_STATES = Object.freeze(['known', 'stale', 'unknown']);
export const CODEX_EXECUTION_CLASSES = Object.freeze(['codex_cloud', 'codex_local', 'external']);

const ALLOWANCE_STATE_SET = new Set(CODEX_ALLOWANCE_STATES);
const WINDOW_KINDS = new Set(['primary', 'secondary']);
const IDENTITY_FIELDS = new Set([
  'device', 'device_id', 'device_name', 'environment', 'environment_id', 'host', 'hostname',
  'machine', 'machine_id', 'provider', 'provider_id', 'region', 'runtime_id', 'vm', 'vm_id',
]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CODEX_CAPACITY_INVALID', `${field} must be an object`, { field });
  return value;
}

function exactFields(value, allowed, field) {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) {
    const identity = extras.filter((key) => IDENTITY_FIELDS.has(key));
    fail(identity.length ? 'CODEX_ENVIRONMENT_IDENTITY_FORBIDDEN' : 'CODEX_CAPACITY_INVALID',
      identity.length ? `${field} must not identify a concrete execution environment` : `${field} contains unsupported fields`,
      { field, unsupported_fields: extras });
  }
}

function optionalTimestamp(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('CODEX_CAPACITY_INVALID', `${field} must be an ISO-8601 timestamp`, { field });
  return new Date(parsed).toISOString();
}

function normalizeWindow(window, index) {
  const value = object(window, `allowance.windows[${index}]`);
  exactFields(value, new Set(['kind', 'used_percent', 'reset_at']), `allowance.windows[${index}]`);
  if (!WINDOW_KINDS.has(value.kind)) fail('CODEX_CAPACITY_INVALID', 'allowance window kind must be primary or secondary', { index, kind: value.kind });
  const usedPercent = Number(value.used_percent);
  if (!Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    fail('CODEX_CAPACITY_INVALID', 'used_percent must be between 0 and 100', { index, used_percent: value.used_percent });
  }
  return Object.freeze({ kind: value.kind, used_percent: usedPercent, reset_at: optionalTimestamp(value.reset_at, `allowance.windows[${index}].reset_at`) });
}

export function normalizeCodexAllowanceObservation(input = {}) {
  const value = object(input, 'allowance');
  exactFields(value, new Set(['state', 'observed_at', 'windows']), 'allowance');
  const state = value.state || 'unknown';
  if (!ALLOWANCE_STATE_SET.has(state)) fail('CODEX_CAPACITY_INVALID', 'allowance.state must be known, stale, or unknown', { state });
  const observedAt = optionalTimestamp(value.observed_at, 'allowance.observed_at');
  const rawWindows = value.windows === undefined ? [] : value.windows;
  if (!Array.isArray(rawWindows) || rawWindows.length > 2) fail('CODEX_CAPACITY_INVALID', 'allowance.windows must contain at most primary and secondary windows');
  const windows = rawWindows.map(normalizeWindow);
  if (new Set(windows.map((window) => window.kind)).size !== windows.length) fail('CODEX_CAPACITY_INVALID', 'allowance window kinds must be unique');
  if (state === 'unknown' && (observedAt || windows.length)) fail('CODEX_CAPACITY_INVALID', 'unknown allowance must not carry observed quota values');
  if (state !== 'unknown' && !observedAt) fail('CODEX_CAPACITY_INVALID', `${state} allowance requires observed_at`);
  return Object.freeze({ state, observed_at: observedAt, windows: Object.freeze(windows) });
}

function unresolvedExecutionClass(kind, state) {
  return Object.freeze({ kind, state, dispatch_supported: false });
}

export function createCodexExecutionCapacity(input = {}) {
  const value = object(input, 'capacity');
  exactFields(value, new Set(['allowance', 'paid_fallback_allowed']), 'capacity');
  if (value.paid_fallback_allowed === true) {
    fail('CODEX_PAID_FALLBACK_DISABLED', 'automatic paid Codex fallback is disabled by this contract');
  }
  if (value.paid_fallback_allowed !== undefined && value.paid_fallback_allowed !== false) {
    fail('CODEX_CAPACITY_INVALID', 'paid_fallback_allowed must be false when supplied');
  }

  const allowance = normalizeCodexAllowanceObservation(value.allowance || { state: 'unknown' });
  return Object.freeze({
    schema: 'codex-execution-capacity-v1',
    allowance,
    policy: Object.freeze({ preferred_execution_class: 'codex_cloud', paid_fallback_allowed: false }),
    execution_classes: Object.freeze({
      codex_cloud: unresolvedExecutionClass('codex_cloud', 'unresolved'),
      codex_local: unresolvedExecutionClass('codex_local', 'unresolved'),
      external: unresolvedExecutionClass('external', 'unbound'),
    }),
  });
}
