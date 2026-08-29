import { db } from 'hatchable';
import { createOrchestrationAdvanceService, statusForOrchestrationAdvanceError } from './orchestration-advance.js';
import { createOrchestrationDriveService, statusForOrchestrationDriveError } from './orchestration-drive.js';
import { executeCorrelatedCommand } from './orchestration-journal.js';
import { createPostgresSubjectAwareOrchestrationMaintenanceService } from './orchestration-maintenance-subjects.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from './project-transition-leases.js';
import { createPostgresOrchestrationRunService, createPostgresOrchestrationRunStore, statusForOrchestrationRunError } from './orchestration-runs.js';
import { orchestrationResumePacket } from './orchestration-recovery.js';
import { createPostgresOrchestrationRunTargetStore } from './orchestration-run-target-store.js';
import { createTargetAwareOrchestrationRunService } from './orchestration-run-targets.js';

function projectGraphReaderFor(options = {}) {
  if (typeof options.projectGraphReader === 'function') return options.projectGraphReader;
  const runtime = options.projectGraphRuntime || createGitHubProjectGraphRuntime(options);
  return createAuthoritativeProjectGraphReader(runtime);
}

function projectTransitionsFor(options, dbBinding, readProjectGraph) {
  if (options.projectTransitions && typeof options.projectTransitions.acquire === 'function' && typeof options.projectTransitions.settle === 'function') {
    return options.projectTransitions;
  }
  const store = options.projectTransitionStore || createProjectTransitionLeasePostgresStore(dbBinding);
  return createProjectTransitionLeaseService({ store, readProjectGraph, now:options.now });
}

async function executeRegisteredProjectOperator(input, options = {}) {
  if (input.command !== 'orchestration.maintain') {
    return Object.freeze({
      ok:false,
      error:'ORCHESTRATION_ADVANCE_OPERATOR_UNAVAILABLE',
      message:'declared deterministic project operator is not registered',
      command:input.command,
    });
  }
  const response = await executeCorrelatedCommand(
    'orchestration.maintain',
    { run_id:input.run_id },
    () => createPostgresSubjectAwareOrchestrationMaintenanceService({ db:options.db || db }).maintain(),
    {
      statusForFailure:statusForOrchestrationRunError,
      defaultError:'ORCHESTRATION_MAINTENANCE_ERROR',
      defaultMessage:'orchestration.maintain failed',
      flattenDetails:true,
      db:options.db || db,
    },
  );
  return response.body;
}

export function createPostgresTargetAwareOrchestrationRunService(options = {}) {
  const dbBinding = options.db || db;
  const baseStore = options.baseStore || createPostgresOrchestrationRunStore(dbBinding);
  const store = options.store || createPostgresOrchestrationRunTargetStore(dbBinding, baseStore);
  const createBaseService = (facade) => createPostgresOrchestrationRunService({ ...options, db:dbBinding, store:facade });
  return createTargetAwareOrchestrationRunService({
    store,
    createBaseService,
    projectGraphReader:projectGraphReaderFor(options),
  });
}

export function createPostgresOrchestrationAdvanceService(options = {}) {
  const dbBinding = options.db || db;
  const baseStore = options.baseStore || (options.store ? null : createPostgresOrchestrationRunStore(dbBinding));
  const store = options.store || createPostgresOrchestrationRunTargetStore(dbBinding, baseStore);
  const readProjectGraph = projectGraphReaderFor({ ...options, db:dbBinding });
  const projectTransitions = projectTransitionsFor(options, dbBinding, readProjectGraph);
  const executeOperator = typeof options.executeOperator === 'function'
    ? options.executeOperator
    : (input) => executeRegisteredProjectOperator(input, { ...options, db:dbBinding });
  return createOrchestrationAdvanceService({ store, readProjectGraph, projectTransitions, executeOperator });
}

export function createPostgresOrchestrationDriveService(options = {}) {
  const advance = options.orchestrationAdvance && typeof options.orchestrationAdvance.advance === 'function'
    ? options.orchestrationAdvance
    : createPostgresOrchestrationAdvanceService(options);
  return createOrchestrationDriveService({
    advance:(input) => advance.advance(input),
    max_advances:options.maxAdvances ?? 8,
  });
}

export async function orchestrationTargetResumePacket(input, options = {}) {
  const dbBinding = options.db || db;
  const baseStore = options.baseStore || createPostgresOrchestrationRunStore(dbBinding);
  const store = options.store || createPostgresOrchestrationRunTargetStore(dbBinding, baseStore);
  const packet = await orchestrationResumePacket(input, { ...options, db:dbBinding });
  const runId = packet.run_id || input?.run_id;
  const run = runId ? await store.getRun(runId) : null;
  const target = run?.target || null;
  if (!target) return { ...packet, target:null, target_evaluation:null };

  try {
    const targetService = createTargetAwareOrchestrationRunService({
      store,
      createBaseService:(facade) => createPostgresOrchestrationRunService({ ...options, db:dbBinding, store:facade }),
      projectGraphReader:projectGraphReaderFor(options),
    });
    const targetEvaluation = await targetService.resolveHorizon({ run_id:runId });
    return { ...packet, target, target_evaluation:targetEvaluation };
  } catch (error) {
    return {
      ...packet,
      target,
      target_evaluation:null,
      target_evaluation_error:{ code:String(error?.code || 'TARGET_EVALUATION_FAILED'), message:String(error?.message || error) },
    };
  }
}

export function statusForTargetAwareOrchestrationError(error) {
  const code = String(error?.code || 'ORCHESTRATION_ERROR');
  if (code === 'PROJECT_GRAPH_READER_UNAVAILABLE') return 503;
  if (code.startsWith('PROJECT_HORIZON_') || code.startsWith('PROJECT_GRAPH_')) return 409;
  return statusForOrchestrationRunError(error);
}

export function statusForOrchestrationAdvanceRuntimeError(error) {
  return statusForOrchestrationAdvanceError(error) || statusForTargetAwareOrchestrationError(error);
}

export function statusForOrchestrationDriveRuntimeError(error) {
  return statusForOrchestrationDriveError(error) || statusForOrchestrationAdvanceRuntimeError(error);
}
