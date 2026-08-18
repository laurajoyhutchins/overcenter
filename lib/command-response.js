export const COMMAND_RESPONSE_SCHEMA_VERSION = 'command-response-v1';

export const CANONICAL_COMMANDS = Object.freeze([
  'work.claim',
  'work.settle',
  'github.apply_changeset',
  'github.delete_branch',
  'github.actions_storage',
  'github.required_checks.ensure',
  'github.branch_policy.reconcile',
  'github.stack.reconcile',
  'github.review_packet',
  'portfolio.reconcile_work_surface',
  'linear.archive',
  'orchestration.resume_packet',
  'orchestration.status',
  'object.capture',
  'object.get_verified',
]);

const COMMAND_SET = new Set(CANONICAL_COMMANDS);
const DEFAULT_STATUS = Object.freeze({
  validation: 422,
  precondition: 409,
  conflict: 409,
  not_found: 404,
  permission: 403,
  setup: 412,
  upstream: 502,
  internal: 500,
});

const EXACT = new Map();
const COMMAND_REJECTION_OVERRIDES = new Map([
  ['github.review_packet:HEAD_MISMATCH', false],
  ['github.review_packet:HEAD_MOVED_DURING_INSPECTION', false],
  ['github.required_checks.ensure:GITHUB_APP_PERMISSION_DENIED', true],
  ['github.required_checks.ensure:GITHUB_PERMISSION_DENIED', true],
  ['github.required_checks.ensure:GITHUB_NOT_FOUND', true],
  ['object.capture:OBJECT_ID_CONFLICT', true],
  ['object.capture:OBJECT_METADATA_CONFLICT', true],
]);

function register(codes, errorClass, retryable = false, httpStatus = DEFAULT_STATUS[errorClass], rejection = false) {
  for (const code of codes) EXACT.set(code, {
    error_class: errorClass,
    retryable,
    http_status: httpStatus,
    rejection,
  });
}

register([
  'REQUEST_INVALID',
], 'validation', false, 400);

register([
  'DUPLICATE_PATH',
  'UNSUPPORTED_BINARY_PAYLOAD',
  'UNSUPPORTED_TARGET_TYPE',
  'UNSUPPORTED_FOLDER',
  'UNSUPPORTED_GOOGLE_NATIVE_OBJECT',
], 'validation');

register([
  'STATE_MISMATCH',
  'LANE_MISMATCH',
  'WORK_STATE_CHANGED',
  'HEAD_MISMATCH',
  'TARGET_BRANCH_DISAPPEARED',
  'CREATE_TARGET_EXISTS',
  'UPDATE_TARGET_MISSING',
  'DELETE_TARGET_MISSING',
  'GITHUB_REF_REJECTED',
  'NON_EXECUTABLE_WORK',
  'INVALID_SUCCESSOR',
  'LEASE_EXPIRED',
  'SOURCE_REVISION_MISMATCH',
  'LINEAR_REVISION_MISMATCH',
  'SOURCE_CLOSED_WITH_ACTIVE_LINEAR_WORK',
  'GITHUB_REQUIRED_CHECK_UNKNOWN',
  'GITHUB_REQUIRED_CHECK_AMBIGUOUS',
  'GITHUB_PROTECTION_CONFLICT',
  'GITHUB_PROTECTION_CHANGED',
  'GITHUB_REQUIRED_CHECKS_VERIFICATION_FAILED',
  'GITHUB_REQUIRED_CHECKS_UNSUPPORTED',
  'GITHUB_BRANCH_POLICY_UNAVAILABLE_BY_PLAN',
  'GITHUB_BRANCH_POLICY_VERIFICATION_FAILED',
  'GITHUB_STACK_TOPOLOGY_INVALID',
  'GITHUB_STACK_CONFLICT',
  'GITHUB_STACK_UNSUPPORTED',
], 'precondition', false, DEFAULT_STATUS.precondition, true);

register([
  'HEAD_MOVED_DURING_INSPECTION',
  'LEASE_INVALID',
  'SHA256_MISMATCH',
  'SIZE_MISMATCH',
  'MIME_TYPE_MISMATCH',
  'IMMUTABLE_OBJECT_CHANGED',
  'OBJECT_NOT_CAPTURED',
  'OBJECT_TRASHED',
  'MISSING_SHA256',
  'RECONCILIATION_FAILED',
], 'precondition');

register([
  'ALREADY_CLAIMED',
  'LEASE_ALREADY_SETTLED',
  'BRANCH_CREATION_RACE',
  'GITHUB_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
], 'conflict', false, DEFAULT_STATUS.conflict, true);

register([
  'OBJECT_ID_CONFLICT',
  'OBJECT_METADATA_CONFLICT',
  'OBJECT_ID_AMBIGUOUS',
], 'conflict');

register(['IDEMPOTENCY_IN_PROGRESS'], 'conflict', true, DEFAULT_STATUS.conflict, true);

register([
  'WORK_NOT_FOUND',
  'PROJECT_NOT_FOUND',
  'DEPENDENCY_NOT_FOUND',
  'GITHUB_NOT_FOUND',
  'GITHUB_APP_INSTALLATION_NOT_FOUND',
  'GOOGLE_DRIVE_NOT_FOUND',
  'OBJECT_NOT_FOUND',
], 'not_found');

register([
  'GITHUB_PERMISSION_DENIED',
  'GITHUB_APP_PERMISSION_DENIED',
  'LINEAR_PERMISSION_DENIED',
  'GOOGLE_DRIVE_PERMISSION_DENIED',
  'OUTSIDE_CONFIGURED_ROOT',
  'SERVICE_ACCOUNT_CANNOT_EDIT',
], 'permission');

register([
  'GITHUB_APP_SETUP_REQUIRED',
  'LINEAR_SETUP_REQUIRED',
  'GOOGLE_DRIVE_SETUP_REQUIRED',
  'LINEAR_CONFIGURATION_ERROR',
  'IDEMPOTENCY_UNAVAILABLE',
  'GITHUB_TRANSPORT_UNAVAILABLE',
  'INVALID_GITHUB_APP_ID',
  'INVALID_GITHUB_APP_PRIVATE_KEY',
], 'setup');

register([
  'GITHUB_UPSTREAM_ERROR',
  'GITHUB_INVALID_RESPONSE',
  'GITHUB_APP_AUTH_ERROR',
  'LINEAR_UPSTREAM_HTTP',
  'LINEAR_UPSTREAM_GRAPHQL',
  'LINEAR_TRANSITION_FAILED',
  'GOOGLE_DRIVE_UPSTREAM_ERROR',
], 'upstream');

register(['CLAIM_INDETERMINATE'], 'upstream', true, 409);
register(['BRANCH_DELETE_INDETERMINATE'], 'upstream', true, 502);
register(['GITHUB_REQUIRED_CHECKS_INDETERMINATE'], 'upstream', true, 502);
register(['GITHUB_BRANCH_POLICY_INDETERMINATE'], 'upstream', true, 502);
register(['GITHUB_STACK_INDETERMINATE'], 'upstream', true, 502);
register(['LINEAR_ARCHIVE_INDETERMINATE'], 'upstream', true, 502);
register(['PORTFOLIO_RECONCILE_INDETERMINATE'], 'upstream', true, 409);
register(['PORTFOLIO_RECONCILE_RECOVERY_CONFLICT'], 'precondition', false, 409, true);
register(['LINEAR_ARCHIVE_NOT_TERMINAL'], 'precondition', false, 409, true);
register(['LINEAR_ARCHIVE_NOT_FOUND'], 'not_found');
register(['LINEAR_ARCHIVE_INVALID_ISSUE'], 'validation', false, 400);
register(['LINEAR_ARCHIVE_NOT_CONFIRMED'], 'upstream', true, 502);
register(['INTERNAL_ERROR'], 'internal');

function assertCommand(command) {
  if (!COMMAND_SET.has(command)) throw new Error(`Unsupported canonical command: ${command}`);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function observedAt(options = {}) {
  if (typeof options.now === 'function') return String(options.now());
  if (options.observed_at) return String(options.observed_at);
  return new Date().toISOString();
}

function fallbackClassification(code) {
  if (code.startsWith('INVALID_')) return { error_class: 'validation', retryable: false, rejection: false, http_status: 422 };
  if (code.endsWith('_PERMISSION_DENIED')) return { error_class: 'permission', retryable: false, rejection: false, http_status: 403 };
  if (code.endsWith('_SETUP_REQUIRED') || code.endsWith('_CONFIGURATION_ERROR')) return { error_class: 'setup', retryable: false, rejection: false, http_status: 412 };
  if (code.endsWith('_NOT_FOUND')) return { error_class: 'not_found', retryable: false, rejection: false, http_status: 404 };
  if (code.startsWith('GITHUB_') || code.startsWith('LINEAR_') || code.startsWith('GOOGLE_DRIVE_')) {
    return { error_class: 'upstream', retryable: false, rejection: false, http_status: 502 };
  }
  return { error_class: 'internal', retryable: false, rejection: false, http_status: 500 };
}

export function classifyCommandError(code, overrides = {}) {
  const stableCode = String(code || 'INTERNAL_ERROR');
  const base = EXACT.get(stableCode) || fallbackClassification(stableCode);
  const errorClass = overrides.error_class || base.error_class;
  const commandOverride = overrides.command
    ? COMMAND_REJECTION_OVERRIDES.get(`${overrides.command}:${stableCode}`)
    : undefined;
  return {
    error_class: errorClass,
    retryable: overrides.retryable === undefined ? Boolean(base.retryable) : Boolean(overrides.retryable),
    rejection: overrides.rejection !== undefined
      ? Boolean(overrides.rejection)
      : (commandOverride === undefined ? Boolean(base.rejection) : Boolean(commandOverride)),
    http_status: Number.isInteger(overrides.http_status) ? overrides.http_status : (base.http_status || DEFAULT_STATUS[errorClass] || 500),
  };
}

const RESERVED_FAILURE_KEYS = new Set([
  'ok', 'command', 'schema_version', 'observed_at', 'run_id', 'error', 'code', 'message',
  'error_class', 'retryable', 'rejection', 'details', 'status', 'httpStatus', 'name', 'stack',
]);

function topLevelEvidence(failure) {
  if (!isObject(failure)) return {};
  return Object.fromEntries(
    Object.entries(failure).filter(([key]) => !RESERVED_FAILURE_KEYS.has(key)),
  );
}

function detailsFor(failure) {
  const topLevel = topLevelEvidence(failure);
  const nested = isObject(failure?.details) ? failure.details : {};
  return { ...topLevel, ...nested };
}

function nativeStatus(failure) {
  const value = Number(failure?.status ?? failure?.httpStatus);
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : null;
}

function mappedStatus(failure, semantic, options = {}) {
  if (typeof options.statusForFailure === 'function') {
    const value = Number(options.statusForFailure(failure));
    if (Number.isInteger(value) && value >= 400 && value <= 599) return value;
  }
  return nativeStatus(failure) || semantic.http_status;
}

function mappedRetryable(failure, semantic, options = {}) {
  if (typeof options.retryableForFailure === 'function') {
    const value = options.retryableForFailure(failure, semantic);
    if (value !== undefined) return Boolean(value);
  }
  if (options.retryable !== undefined) return Boolean(options.retryable);
  return semantic.retryable;
}

function mappedRejection(failure, semantic, options = {}) {
  if (typeof options.rejectionForFailure === 'function') {
    const value = options.rejectionForFailure(failure, semantic);
    if (value !== undefined) return Boolean(value);
  }
  if (options.rejection !== undefined) return Boolean(options.rejection);
  return semantic.rejection;
}

export function commandSuccess(command, result, options = {}) {
  assertCommand(command);
  const domain = isObject(result) ? result : {};
  return {
    ...domain,
    ok: true,
    command,
    schema_version: COMMAND_RESPONSE_SCHEMA_VERSION,
    observed_at: observedAt(options),
    ...(options.run_id ? { run_id: String(options.run_id) } : {}),
  };
}

export function commandFailure(command, failure, options = {}) {
  assertCommand(command);
  const code = String(failure?.error || failure?.code || options.defaultError || 'INTERNAL_ERROR');
  const message = String(failure?.message || options.defaultMessage || `${command} failed`);
  const semantic = classifyCommandError(code, {
    command,
    error_class: options.error_class,
    retryable: options.retryable,
    rejection: options.rejection,
    http_status: options.http_status,
  });
  const retryable = mappedRetryable(failure, semantic, options);
  const rejection = mappedRejection(failure, semantic, options);
  const details = detailsFor(failure);
  const compatibilityTopLevel = topLevelEvidence(failure);
  const flattenedNestedDetails = options.flattenDetails === false || !isObject(failure?.details)
    ? {}
    : failure.details;
  const body = {
    ...compatibilityTopLevel,
    ...flattenedNestedDetails,
    ok: false,
    command,
    schema_version: COMMAND_RESPONSE_SCHEMA_VERSION,
    observed_at: observedAt(options),
    error: code,
    message,
    error_class: semantic.error_class,
    retryable,
    rejection,
    details,
    ...(options.run_id ? { run_id: String(options.run_id) } : {}),
  };
  return {
    status: mappedStatus(failure, { ...semantic, retryable }, options),
    body,
  };
}

export async function executeCommand(command, operation, options = {}) {
  assertCommand(command);
  try {
    const result = await operation();
    if (isObject(result) && result.ok === true) {
      return { status: 200, body: commandSuccess(command, result, options) };
    }
    if (isObject(result) && result.ok === false) {
      return commandFailure(command, result, options);
    }
    return commandFailure(command, {
      code: options.defaultError || 'INTERNAL_ERROR',
      message: options.defaultMessage || `${command} returned an invalid command result`,
      details: { returned_type: result === null ? 'null' : typeof result },
    }, { ...options, flattenDetails: false, http_status: 500, error_class: 'internal', retryable: false });
  } catch (error) {
    const normalized = typeof options.normalizeError === 'function' ? options.normalizeError(error) : error;
    return commandFailure(command, normalized, options);
  }
}