import { db } from 'hatchable';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createPostgresOrchestrationRunService, createPostgresOrchestrationRunStore, statusForOrchestrationRunError } from './orchestration-runs.js';
import { orchestrationResumePacket } from './orchestration-recovery.js';
import { createPostgresOrchestrationRunTargetStore } from './orchestration-run-target-store.js';
import { createTargetAwareOrchestrationRunService } from './orchestration-run-targets.js';

function projectGraphReaderFor(options = {}) {
  if (typeof options.projectGraphReader === 'function') return options.projectGraphReader;
  const runtime = options.projectGraphRuntime || createGitHubProjectGraphRuntime(options);
  return createAuthoritativeProjectGraphReader(runtime);
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
