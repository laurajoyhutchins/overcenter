import { db as hatchableDb } from 'hatchable';
import { commandFailure } from 'lib/command-response.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { sanitizeWorkerBoundaryError, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { createPostgresSubjectAwareLeaseCheckpointService, createPostgresSubjectAwareLeaseHeartbeatService, createPostgresSubjectAwareLeaseSettlementService, createPostgresSubjectAwareOrchestrationRunService } from 'lib/orchestration-finish-runtime.js';
import { createAuthoritativeProjectGraphReader } from 'lib/project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from 'lib/project-graph-github-runtime.js';
import { createProjectTransitionLeasePostgresStore } from 'lib/project-transition-lease-store.js';
import {
  createProjectGraphDeriverBootstrapConfirmationService,
  createProjectTransitionLeaseService,
  statusForProjectGraphDeriverBootstrapConfirmationError,
} from 'lib/project-transition-leases.js';
import { createPostgresOrchestrationAdvanceService, createPostgresTargetAwareOrchestrationRunService, statusForOrchestrationAdvanceRuntimeError } from 'lib/orchestration-run-target-runtime.js';
import { createPostgresOrchestrationDiagnosisService } from 'lib/orchestration-recovery.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { createGithubReleaseWithGitHubApp } from 'lib/github-release-runtime.js';
import { markGithubPullRequestReadyWithGitHubApp } from 'lib/github-pull-request-ready.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';
import { productionPromotionFor } from 'lib/production-promotion-overcenter-host.js';
import { releasePublishingFor } from 'lib/release-publish-overcenter-host.js';
import { projectAdvanceFor } from 'lib/project-advance-overcenter-host.js';
import { projectInspectForGitHub } from 'lib/project-inspect-github-runtime.js';
import { normalizeProjectDefineRequest, normalizeProjectAmendRequest } from 'lib/project-authoring-command-contract.js';
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

function orchestrationAdvanceFor(runtime = {}) {
  if (runtime.orchestrationAdvance && typeof runtime.orchestrationAdvance.advance === 'function') return runtime.orchestrationAdvance;
  return createPostgresOrchestrationAdvanceService({ ...runtime, db:runtime.db || hatchableDb });
}

function projectAdvanceRuntimeFor(runtime = {}) {
  if (runtime.projectAdvance && typeof runtime.projectAdvance.advance === 'function') return runtime.projectAdvance;
  const dbBinding = runtime.db || hatchableDb;
  const runs = runtime.orchestrationRuns || createPostgresTargetAwareOrchestrationRunService({ db:dbBinding });
  const advance = runtime.orchestrationAdvance || createPostgresOrchestrationAdvanceService({ db:dbBinding });
  const finish = runtime.orchestrationFinish || createPostgresSubjectAwareOrchestrationRunService({ db:dbBinding });
  return projectAdvanceFor({ db:dbBinding, runs, advance, finish });
}

function projectInspectionFor(runtime = {}) {
  if (runtime.projectInspect && typeof runtime.projectInspect.inspect === 'function') return runtime.projectInspect;
  return projectInspectForGitHub({ db:runtime.db || hatchableDb, createGitHubProjectGraphRuntime });
}

function projectAuthoringFor(runtime = {}) {
  if (runtime.projectAuthoring && typeof runtime.projectAuthoring.define === 'function' && typeof runtime.projectAuthoring.amend === 'function') {
    return runtime.projectAuthoring;
  }
  throw invalid('project authoring runtime is unavailable');
}

function releasePublishingRuntimeFor(runtime = {}) {
  if (runtime.releasePublishing && typeof runtime.releasePublishing.publish === 'function') return runtime.releasePublishing;
  return releasePublishingFor({ db:runtime.db || hatchableDb });
}

function workCheckpointFor(runtime = {}) {
  if (runtime.workCheckpoint && typeof runtime.workCheckpoint.checkpointByRef === 'function') return runtime.workCheckpoint;
  return createPostgresSubjectAwareLeaseCheckpointService({ db:runtime.db || hatchableDb });
}

function workHeartbeatFor(runtime = {}) {
  if (runtime.workHeartbeat && typeof runtime.workHeartbeat.heartbeatByRef === 'function') return runtime.workHeartbeat;
  return createPostgresSubjectAwareLeaseHeartbeatService({ db:runtime.db || hatchableDb });
}

function workSettlementFor(runtime = {}) {
  if (runtime.workSettlement && typeof runtime.workSettlement.settleByRef === 'function') return runtime.workSettlement;
  return createPostgresSubjectAwareLeaseSettlementService({ db:runtime.db || hatchableDb });
}

const githubPullRequestMarkReadyDescriptor = semanticCommandDescriptor('github.pull_request.mark_ready');
const githubReleaseDescriptor = semanticCommandDescriptor('github.release.create');
const orchestrationDiagnoseDescriptor = semanticCommandDescriptor('orchestration.diagnose');
const productionPromotionDescriptor = semanticCommandDescriptor('production.promote');
const releasePublishDescriptor = semanticCommandDescriptor('release.publish');
const projectAdvanceDescriptor = semanticCommandDescriptor('project.advance');
const projectInspectDescriptor = semanticCommandDescriptor('project.inspect');
const workSettleDescriptor = semanticCommandDescriptor('work.settle');
const projectDefineDescriptor = semanticCommandDescriptor('project.define');
const projectAmendDescriptor = semanticCommandDescriptor('project.amend');

const specs = {
  'github.pull_request.mark_ready': {
    allowed: new Set(githubPullRequestMarkReadyDescriptor.semantic_fields),
    required: new Set(githubPullRequestMarkReadyDescriptor.required_fields),
    canonicalize: async (input) => ({ ...input }),
    execute: (request) => markGithubPullRequestReadyWithGitHubApp(request),
    statusForFailure: () => null,
    defaultError: 'GITHUB_PULL_REQUEST_MARK_READY_ERROR',
    defaultMessage: 'github.pull_request.mark_ready failed',
  },
  'github.release.create': {
    allowed: new Set(githubReleaseDescriptor.semantic_fields),
    required: new Set(githubReleaseDescriptor.required_fields),
    canonicalize: async (input) => ({ ...input }),
    execute: (request) => createGithubReleaseWithGitHubApp(request),
    statusForFailure: () => null,
    defaultError: 'GITHUB_RELEASE_ERROR',
    defaultMessage: 'github.release.create failed',
  },
  'orchestration.advance': {
    allowed: new Set(['run_id']),
    required: new Set(['run_id']),
    canonicalize: async (input) => ({ ...input }),
    execute: (request, runtime) => orchestrationAdvanceFor(runtime).advance(request),
    statusForFailure: statusForOrchestrationAdvanceRuntimeError,
    defaultError: 'ORCHESTRATION_ADVANCE_ERROR',
    defaultMessage: 'orchestration.advance failed',
  },
  'orchestration.diagnose': {
    allowed: new Set(orchestrationDiagnoseDescriptor.semantic_fields),
    required: new Set(orchestrationDiagnoseDescriptor.required_fields),
    canonicalize: async (input) => ({ ...input }),
    execute: (request) => createPostgresOrchestrationDiagnosisService().diagnose(request),
    statusForFailure: statusForOrchestrationRunError,
    defaultError: 'ORCHESTRATION_DIAGNOSE_ERROR',
    defaultMessage: 'orchestration.diagnose failed',
  },
  'production.promote': {
    allowed: new Set(productionPromotionDescriptor.semantic_fields),
    required: new Set(productionPromotionDescriptor.required_fields),
    canonicalize: async (input) => ({ ...input }),
    execute: (request, runtime) => productionPromotionFor({ db:runtime.db || hatchableDb }).promote(request),
    statusForFailure: () => null,
    defaultError: 'PRODUCTION_PROMOTION_ERROR',
    defaultMessage: 'production.promote failed',
  },
  'release.publish': {
    allowed: new Set(releasePublishDescriptor.semantic_fields),
    required: new Set(releasePublishDescriptor.required_fields),
    canonicalize: async (input) => ({ ...input }),
    execute: (request, runtime) => releasePublishingRuntimeFor(runtime).publish(request),
    statusForFailure: () => null,
    defaultError: 'RELEASE_PUBLISH_ERROR',
    defaultMessage: 'release.publish failed',
  },
  'project.advance': {
    allowed: new Set(projectAdvanceDescriptor.semantic_fields),
    required: new Set(projectAdvanceDescriptor.required_fields),
    canonicalize: async (input) => ({ ...input }),
    execute: (request, runtime) => projectAdvanceRuntimeFor(runtime).advance(request),
    statusForFailure: statusForOrchestrationAdvanceRuntimeError,
    defaultError: 'PROJECT_ADVANCE_ERROR',
    defaultMessage: 'project.advance failed',
  },
  'project.inspect': {
    allowed: new Set(projectInspectDescriptor.semantic_fields),
    required: new Set(projectInspectDescriptor.required_fields),
    canonicalize: async (input) => ({ ...input }),
    execute: (request, runtime) => projectInspectionFor(runtime).inspect(request),
    statusForFailure: () => null,
    defaultError: 'PROJECT_INSPECT_ERROR',
    defaultMessage: 'project.inspect failed',
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
  'project.define': {
    allowed: new Set(projectDefineDescriptor.semantic_fields),
    required: new Set(projectDefineDescriptor.required_fields),
    canonicalize: normalizeProjectDefineRequest,
    execute: (request, runtime) => projectAuthoringFor(runtime).define(request),
    statusForFailure: () => null,
    defaultError: 'PROJECT_DEFINE_ERROR',
    defaultMessage: 'project.define failed',
  },
  'project.amend': {
    allowed: new Set(projectAmendDescriptor.semantic_fields),
    required: new Set(projectAmendDescriptor.required_fields),
    canonicalize: normalizeProjectAmendRequest,
    execute: (request, runtime) => projectAuthoringFor(runtime).amend(request),
    statusForFailure: () => null,
    defaultError: 'PROJECT_AMEND_ERROR',
    defaultMessage: 'project.amend failed',
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
    execute: (request, runtime) => workCheckpointFor(runtime).checkpointByRef(request),
    defaultError: 'WORK_CHECKPOINT_ERROR',
    defaultMessage: 'work.checkpoint failed',
  },
  'work.heartbeat': {
    allowed: new Set(WORK_HEARTBEAT_SEMANTIC_FIELDS),
    required: new Set(WORK_HEARTBEAT_REQUIRED_FIELDS),
    canonicalize: canonicalHeartbeatCommandByRef,
    execute: (request, runtime) => workHeartbeatFor(runtime).heartbeatByRef(request),
    defaultError: 'WORK_HEARTBEAT_ERROR',
    defaultMessage: 'work.heartbeat failed',
  },
  'work.settle': {
    allowed: new Set(workSettleDescriptor.semantic_fields),
    required: new Set(workSettleDescriptor.required_fields),
    canonicalize: canonicalSettleCommandByRef,
    execute: (request, runtime) => workSettlementFor(runtime).settleByRef(request),
    defaultError: 'WORK_SETTLE_ERROR',
    defaultMessage: 'work.settle failed',
  },
};

function invalid(message, details = {}) {
  const error = new Error(message);
  error.code = 'REQUEST_INVALID';
  error.details = details;
  throw error;
}

async function validateSpecInput(command, input, spec) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const allowed = spec.allowed || new Set();
  const required = spec.required || new Set();
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unsupported.length) throw invalid('semantic worker input contains unsupported fields', { command, unsupported_fields:unsupported });
  const missing = [...required].filter((key) => value[key] == null || value[key] === '');
  if (missing.length) throw invalid('semantic worker input is missing required fields', { command, missing_fields:missing.sort() });
  return spec.canonicalize(value);
}

export async function validateSemanticWorkerCommand(command, input = {}) {
  const spec = specs[command];
  if (!spec) throw invalid('unsupported semantic worker command', { command });
  return validateSpecInput(command, input, spec);
}

export async function executeSemanticWorkerCommand(command, input = {}, runtime = {}) {
  try {
    const spec = specs[command];
    if (!spec) throw invalid('unsupported semantic worker command', { command });
    const request = await validateSpecInput(command, input, spec);
    const result = spec.execute
      ? await spec.execute(request, runtime)
      : await executeCorrelatedCommand(command, request, async (canonical) => {
          const leases = runtime.leases || createPostgresWorkLeaseService({ db:runtime.db || hatchableDb });
          return leases[spec.method](canonical);
        }, {
          db:runtime.db || hatchableDb,
          statusForFailure:spec.statusForFailure || statusForWorkLeaseError,
          defaultError:spec.defaultError,
          defaultMessage:spec.defaultMessage,
          flattenDetails:true,
        });
    return result?.status && result?.body ? result : { status:200, body:result };
  } catch (error) {
    const sanitized = sanitizeWorkerBoundaryError(error, runtime.logger || console);
    const defaultSpec = specs[command] || {};
    return commandFailure(command || 'unknown', sanitized, {
      status: defaultSpec.statusForFailure?.(sanitized) || statusForWorkLeaseError(sanitized) || 400,
      defaultError: defaultSpec.defaultError || 'WORKER_COMMAND_ERROR',
      defaultMessage: defaultSpec.defaultMessage || 'worker command failed',
      flattenDetails:true,
      ...workerBoundaryFailureOptions(sanitized),
    });
  }
}