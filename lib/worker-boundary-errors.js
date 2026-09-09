import { classifyCommandError, commandFailure } from 'lib/command-response.js';

function failureCode(error, defaultError) {
  return String(error?.error || error?.code || defaultError || 'INTERNAL_ERROR');
}

function mayHaveMutated(error, kind) {
  const explicit = error?.may_have_mutated ?? error?.details?.may_have_mutated;
  if (typeof explicit === 'boolean') return explicit;
  return kind === 'database_infrastructure';
}

function failureKind(error, code) {
  if (code.startsWith('LINEAR_')) return 'upstream_provider';
  if (code.startsWith('RUNTIME_PROVIDER_')) return 'runtime_provider';
  const message = String(error?.message || '');
  if (/^[0-9A-Z]{5}$/.test(code) || /SQLSTATE|internal\/db\/query|PostgreSQL|postgres|database connection/i.test(message)) {
    return 'database_infrastructure';
  }
  return 'unexpected_application';
}

function publicDiagnosticCode(code) {
  const normalized = String(code || '').trim();
  return /^[A-Z0-9_]{2,128}$/.test(normalized) ? normalized : 'UNCLASSIFIED_INTERNAL_FAILURE';
}

export function sanitizeWorkerBoundaryError(command, error, options = {}) {
  const defaultError = options.defaultError || 'INTERNAL_ERROR';
  const defaultMessage = options.defaultMessage || `${command} failed`;
  const code = failureCode(error, defaultError);
  const semantic = classifyCommandError(code, { command });
  const providerFailure = code.startsWith('LINEAR_');
  if (semantic.error_class !== 'internal' && semantic.error_class !== 'upstream' && !providerFailure) return error;

  const stableCode = semantic.error_class === 'internal' ? defaultError : code;
  const diagnosticCode = publicDiagnosticCode(code);
  const kind = failureKind(error, code);
  const mutated = mayHaveMutated(error, kind);
  const log = options.logger || console;
  if (typeof log?.error === 'function') {
    log.error(JSON.stringify({
      event: 'worker_command_internal_failure',
      command,
      phase: options.phase || 'execute',
      failure_kind: kind,
      error_code: diagnosticCode,
      error_name: typeof error?.name === 'string' ? error.name : null,
      may_have_mutated: mutated,
    }));
  }

  const sanitized = new Error(defaultMessage);
  sanitized.code = stableCode;
  sanitized.may_have_mutated = mutated;
  sanitized.details = Object.freeze({
    diagnostic_error_code:diagnosticCode,
    diagnostic_failure_kind:kind,
    may_have_mutated:mutated,
  });
  return sanitized;
}

export function workerBoundaryFailureOptions(command, options = {}) {
  const { logger, phase, ...passthrough } = options;
  const defaults = {
    ...passthrough,
    statusForFailure: options.statusForFailure,
    defaultError: options.defaultError,
    defaultMessage: options.defaultMessage,
    flattenDetails: options.flattenDetails !== false,
  };
  return {
    ...defaults,
    normalizeError: (error) => sanitizeWorkerBoundaryError(command, error, {
      defaultError: defaults.defaultError,
      defaultMessage: defaults.defaultMessage,
      phase: phase || 'execute',
      logger,
    }),
  };
}

export function workerBoundaryCommandFailure(command, error, options = {}) {
  const normalized = sanitizeWorkerBoundaryError(command, error, {
    defaultError: options.defaultError,
    defaultMessage: options.defaultMessage,
    phase: options.phase || 'canonicalize',
    logger: options.logger,
  });
  return commandFailure(command, normalized, workerBoundaryFailureOptions(command, options));
}
