import { classifyCommandError, commandFailure } from 'lib/command-response.js';

const NO_AUTHORITY_MUTATION_COMMANDS = new Set(['work.claim']);

function failureCode(error, defaultError) {
  return String(error?.error || error?.code || defaultError || 'INTERNAL_ERROR');
}

function mayHaveMutated(error, command = null, semantic = null) {
  const observed = error?.may_have_mutated ?? error?.details?.may_have_mutated;
  if (typeof observed === 'boolean') return observed;
  if (NO_AUTHORITY_MUTATION_COMMANDS.has(command) && semantic?.error_class === 'upstream') return false;
  return true;
}

function failureKind(error, code, semantic) {
  if (semantic?.error_class === 'upstream') return 'upstream_provider';
  const message = String(error?.message || '');
  if (/^[0-9A-Z]{5}$/.test(code) || /SQLSTATE|internal\/db\/query|PostgreSQL|postgres|database connection/i.test(message)) {
    return 'database_infrastructure';
  }
  return 'unexpected_application';
}

export function sanitizeWorkerBoundaryError(command, error, options = {}) {
  const defaultError = options.defaultError || 'INTERNAL_ERROR';
  const defaultMessage = options.defaultMessage || `${command} failed`;
  const code = failureCode(error, defaultError);
  const semantic = classifyCommandError(code, { command });
  const providerFailure = code.startsWith('LINEAR_');
  if (semantic.error_class !== 'internal' && semantic.error_class !== 'upstream' && !providerFailure) return error;

  const stableCode = semantic.error_class === 'internal' ? defaultError : code;
  const mutationStatus = mayHaveMutated(error, command, semantic);
  const log = options.logger || console;
  if (typeof log?.error === 'function') {
    log.error(JSON.stringify({
      event: 'worker_command_internal_failure',
      command,
      phase: options.phase || 'execute',
      failure_kind: failureKind(error, code, semantic),
      error_code: code || null,
      error_name: typeof error?.name === 'string' ? error.name : null,
      may_have_mutated: mutationStatus,
    }));
  }

  const sanitized = new Error(defaultMessage);
  sanitized.code = stableCode;
  sanitized.may_have_mutated = mutationStatus;
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
    retryableForFailure: (failure, semantic) => {
      if (typeof options.retryableForFailure === 'function') {
        const explicit = options.retryableForFailure(failure, semantic);
        if (explicit !== undefined) return explicit;
      }
      if (command === 'work.claim' && semantic?.error_class === 'upstream' && !mayHaveMutated(failure)) return true;
      return undefined;
    },
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