import { db as hatchableDb } from 'hatchable';
import { commandFailure } from 'lib/command-response.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { sanitizeWorkerBoundaryError, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { createAuthoritativeProjectGraphReader } from 'lib/project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from 'lib/project-graph-github-runtime.js';
import { createProjectTransitionLeasePostgresStore } from 'lib/project-transition-lease-store.js';
import {
  createProjectGraphDeriverBootstrapConfirmationService,
  createProjectTransitionLeaseService,
  statusForProjectGraphDeriverBootstrapConfirmationError,
} from 'lib/project-transition-leases.js';
import { createPostgresOrchestrationDiagnosisService } from 'lib/orchestration-recovery.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { createGithubReleaseWithGitHubApp } from 'lib/github-release-runtime.js';
import { GITHUB_RELEASE_REQUIRED_FIELDS, GITHUB_RELEASE_SEMANTIC_FIELDS } from 'lib/github-release-contract.js';
import { WORK_SETTLE_REQUIRED_FIELDS, WORK_SETTLE_SEMANTIC_FIELDS } from 'lib/work-settle-contract.js';
import {
  WORK_CHECKPOINT_REQUIRED_FIELDS,
  WORK_CHECKPOINT_SEMANTIC_FIELDS,
  WORK_HEARTBEAT_REQUIRED_FIELDS,
  WORK_HEARTBEAT_SEMANTIC_FIELDS,
} from 'lib/work-progress-contract.js';
import { canonicalSkillCompleteCommand, createPostgresSkillExecutionService, statusForSkillExecutionError } from 'lib/skill-execution.js';
import {
  canonicalClaimCommand,
  canonicalCheckpointCommandByRef,
  canonicalHeartbeatCommandByRef,
  canonicalSettleCommandByRef,
} from 'lib/operator-commands.js';

function projectBootstrapConfirmationFor(runtime = {}) {
  if (runtime.projectBootstrapConfirmation && typeof runtime.projectBootstrapConfirmation.confirm === 'function') {
    return runtime.projectBootstrapConfirmation;
  }
  const dbBinding = runtime.db || hatchableDb;
  const graphRuntime = createGitHubProjectGraphRuntime({ db:dbBinding });
  const readProjectGraph = createAuthoritativeProjectGraphReader(graphRuntime);
  const store = createProjectTransitionLeasePostgresStore(dbBinding);
  const projectTransitions = createProjectTransitionLeaseService({ store, readProjectGraph });
  return createProjectGraphDeriverBootstrapConfirmationService({ projectTransitions, readProjectGraph });
}

const specs = {
  'github.release.create': {
    allowed: new Set(GITHUB_RELEASE_SEMANTIC_FIELDS),
    required: new Set(GITHUB_RELEASE_REQUIRED_FIELDS),
    canonicalize: async (input) => ({ ...input }),
    execute: (request) => createGithubReleaseWithGitHubApp(request),
    statusForFailure: () => null,
    defaultError: 'GITHUB_RELEASE_ERROR',
    defaultMessage: 'github.release.create failed',
  },
  'orchestration.diagnose': {
    allowed: new Set(['run_id','work_ref']),
    canonicalize: async (input) => ({ ...input }),
    execute: (request) => createPostgresOrchestrationDiagnosisService().diagnose(request),
    statusForFailure: statusForOrchestrationRunError,
    defaultError: 'ORCHESTRATION_DIAGNOSE_ERROR',
    defaultMessage: 'orchestration.diagnose failed',
  },
  'project.bootstrap_confirm_graph_deriver': {
    allowed: new Set(['run_id']),
    required: new Set(['run_id']),
    canonicalize: async (input) => ({ ...input }),
    execute: (request, runtime) => projectBootstrapConfirmationFor(runtime).confirm(request),
    statusForFailure: statusForProjectGraphDeriverBootstrapConfirmationError,
    defaultError: 'PROJECT_BOOTSTRAP_CONFIRMATION_ERROR',
    defaultMessage: 'project.bootstrap_confirm_graph_deriver failed',
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
    allowed: new Set(WORK_CHECKPOINT_SEMANTIC_FIELDS),
    required: new Set(WORK_CHECKPOINT_REQUIRED_FIELDS),
    canonicalize: canonicalCheckpointCommandByRef,
    method: 'checkpointByRef',
    defaultError: 'WORK_CHECKPOINT_ERROR',
    defaultMessage: 'work.checkpoint failed',
  },
  'work.heartbeat': {
    allowed: new Set(WORK_HEARTBEAT_SEMANTIC_FIELDS),
    required: new Set(WORK_HEARTBEAT_REQUIRED_FIELDS),
    canonicalize: canonicalHeartbeatCommandByRef,
    method: 'heartbeatByRef',
    defaultError: 'WORK_HEARTBEAT_ERROR',
    defaultMessage: 'work.heartbeat failed',
  },
  'work.settle': {
    allowed: new Set(WORK_SETTLE_SEMANTIC_FIELDS),
    required: new Set(WORK_SETTLE_REQUIRED_FIELDS),
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

function boundedRejectedCommand(command) {
  const text = typeof command === 'string' ? command.trim() : '';
  return text ? text.slice(0, 128) : 'unknown';
}

function unsupportedSemanticWorkerCommand(command) {
  const rejectedCommand = boundedRejectedCommand(command);
  const response = commandFailure('work.claim', invalid('unsupported semantic worker command', { command: rejectedCommand }), {
    flattenDetails: true,
    http_status: 400,
  });
  return { ...response, body: { ...response.body, command: rejectedCommand } };
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
  if (spec.required) {
    const missing = [...spec.required].filter((key) => !Object.prototype.hasOwnProperty.call(input, key));
    if (missing.length) throw invalid('semantic worker input is missing required fields', { command, missing_fields: missing.sort() });
  }
  return { ...input };
}

export async function executeSemanticWorkerCommand(command, input, runtime = {}) {
  const spec = specs[command];
  if (!spec) return unsupportedSemanticWorkerCommand(command);
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
    (request) => spec.execute ? spec.execute(request, runtime) : service[spec.method](request),
    options,
  );
  if (command === 'work.claim' && response.body?.ok === true) {
    const { lease_token: _secretCapability, ...safeBody } = response.body;
    return { ...response, body: { ...safeBody, lease_ref: response.body.lease_id } };
  }
  return response;
}
