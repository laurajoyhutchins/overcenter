import { commandFailure } from 'lib/command-response.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import {
  canonicalClaimCommand,
  canonicalCheckpointCommand,
  canonicalHeartbeatCommand,
  canonicalSettleCommand,
} from 'lib/operator-commands.js';

const specs = {
  'work.claim': {
    allowed: new Set(['work_ref','run_id','observed_state','observed_lane','lease_seconds']),
    canonicalize: canonicalClaimCommand,
    method: 'claim',
    defaultError: 'WORK_CLAIM_ERROR',
    defaultMessage: 'work.claim failed',
  },
  'work.checkpoint': {
    allowed: new Set(['lease_token','phase','next_action','candidate','completed','evidence','authority_revisions']),
    canonicalize: canonicalCheckpointCommand,
    method: 'checkpoint',
    defaultError: 'WORK_CHECKPOINT_ERROR',
    defaultMessage: 'work.checkpoint failed',
  },
  'work.heartbeat': {
    allowed: new Set(['lease_token','extend_seconds','phase','next_action','candidate','completed','evidence','authority_revisions']),
    canonicalize: canonicalHeartbeatCommand,
    method: 'heartbeat',
    defaultError: 'WORK_HEARTBEAT_ERROR',
    defaultMessage: 'work.heartbeat failed',
  },
  'work.settle': {
    allowed: new Set(['lease_token','disposition','evidence','reason','promotion_condition','requeue_class','continuation','next_state','next_lane']),
    canonicalize: canonicalSettleCommand,
    method: 'settle',
    defaultError: 'WORK_SETTLE_ERROR',
    defaultMessage: 'work.settle failed',
  },
};

function invalid(message, details = {}) {
  const error = new Error(message);
  error.code = 'REQUEST_INVALID';
  error.details = details;
  return error;
}

export function validateSemanticWorkerCommand(command, input) {
  const spec = specs[command];
  if (!spec) throw invalid('unsupported semantic worker command', { command: command || null });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('input must be an object');
  }
  const unknown = Object.keys(input).filter((key) => !spec.allowed.has(key));
  if (unknown.length) {
    throw invalid('semantic worker input contains unsupported fields', {
      command,
      unsupported_fields: unknown.sort(),
    });
  }
  return { ...input };
}

export async function executeSemanticWorkerCommand(command, input) {
  const spec = specs[command];
  if (!spec) throw invalid('unsupported semantic worker command', { command: command || null });
  const options = {
    statusForFailure: statusForWorkLeaseError,
    defaultError: spec.defaultError,
    defaultMessage: spec.defaultMessage,
    flattenDetails: true,
  };

  let semantic;
  let canonical;
  try {
    semantic = validateSemanticWorkerCommand(command, input);
    canonical = await spec.canonicalize(semantic);
  } catch (error) {
    return commandFailure(command, error, options);
  }

  const service = createPostgresWorkLeaseService();
  return executeCorrelatedCommand(
    command,
    canonical,
    (request) => service[spec.method](request),
    options,
  );
}