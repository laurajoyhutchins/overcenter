import { commandFailure } from 'lib/command-response.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { sanitizeWorkerBoundaryError, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { createPostgresOrchestrationDiagnosisService } from 'lib/orchestration-recovery.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { canonicalSkillCompleteCommand, createPostgresSkillExecutionService, statusForSkillExecutionError } from 'lib/skill-execution.js';
import {
  canonicalClaimCommand,
  canonicalCheckpointCommandByRef,
  canonicalHeartbeatCommandByRef,
  canonicalSettleCommandByRef,
} from 'lib/operator-commands.js';

const specs = {
  'orchestration.diagnose': {
    allowed: new Set(['run_id','work_ref']),
    canonicalize: async (input) => ({ ...input }),
    execute: (request) => createPostgresOrchestrationDiagnosisService().diagnose(request),
    statusForFailure: statusForOrchestrationRunError,
    defaultError: 'ORCHESTRATION_DIAGNOSE_ERROR',
    defaultMessage: 'orchestration.diagnose failed',
  },
  'skill.activate': {
    allowed: new Set(['run_id','skill','reason']),
    canonicalize: async (input) => ({ ...input }),
    execute: (request, runtime) => createPostgresSkillExecutionService({ db:runtime.db }).activate(request),
    statusForFailure: statusForSkillExecutionError,
    defaultError: 'SKILL_ACTIVATE_ERROR',
    defaultMessage: 'skill.activate failed',
  },
  'skill.complete': {
    allowed: new Set(['run_id','activation_id','outcome','evidence']),
    canonicalize: canonicalSkillCompleteCommand,
    execute: (request, runtime) => createPostgresSkillExecutionService({ db:runtime.db }).complete(request),
    statusForFailure: statusForSkillExecutionError,
    defaultError: 'SKILL_COMPLETE_ERROR',
    defaultMessage: 'skill.complete failed',
  },
  'work.claim': {
    allowed: new Set(['work_ref','run_id','observed_revision','lease_seconds']),
    canonicalize: canonicalClaimCommand,
    method: 'claim',
    defaultError: 'WORK_CLAIM_ERROR',
    defaultMessage: 'work.claim failed',
  },
  'work.checkpoint': {
    allowed: new Set(['lease_ref','phase','next_action','candidate','completed','evidence','authority_revisions']),
    canonicalize: canonicalCheckpointCommandByRef,
    method: 'checkpointByRef',
    defaultError: 'WORK_CHECKPOINT_ERROR',
    defaultMessage: 'work.checkpoint failed',
  },
  'work.heartbeat': {
    allowed: new Set(['lease_ref','extend_seconds','phase','next_action','candidate','completed','evidence','authority_revisions']),
    canonicalize: canonicalHeartbeatCommandByRef,
    method: 'heartbeatByRef',
    defaultError: 'WORK_HEARTBEAT_ERROR',
    defaultMessage: 'work.heartbeat failed',
  },
  'work.settle': {
    allowed: new Set(['lease_ref','disposition','evidence','reason','promotion_condition','requeue_class','continuation','lifecycle_facts']),
    canonicalize: canonicalSettleCommandByRef,
    method: 'settleByRef',
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

export async function executeSemanticWorkerCommand(command, input, runtime = {}) {
  const spec = specs[command];
  if (!spec) throw invalid('unsupported semantic worker command', { command: command || null });
  const options = workerBoundaryFailureOptions(command, {
    statusForFailure: spec.statusForFailure || statusForWorkLeaseError,
    defaultError: spec.defaultError,
    defaultMessage: spec.defaultMessage,
    flattenDetails: true,
    logger: runtime.logger,
  });

  let semantic;
  let canonical;
  try {
    semantic = validateSemanticWorkerCommand(command, input);
    canonical = await spec.canonicalize(semantic, runtime.db);
  } catch (error) {
    const normalized = sanitizeWorkerBoundaryError(command, error, {
      defaultError: spec.defaultError,
      defaultMessage: spec.defaultMessage,
      phase: 'canonicalize',
      logger: runtime.logger,
    });
    return commandFailure(command, normalized, options);
  }

  const service = spec.execute ? null : createPostgresWorkLeaseService(runtime);
  const response = await executeCorrelatedCommand(
    command,
    canonical,
    (request) => spec.execute ? spec.execute(request) : service[spec.method](request),
    options,
  );
  if (command === 'work.claim' && response.body?.ok === true) {
    const { lease_token: _secretCapability, ...safeBody } = response.body;
    return { ...response, body: { ...safeBody, lease_ref: response.body.lease_id } };
  }
  return response;
}