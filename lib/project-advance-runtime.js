import { projectAdvanceFor } from './project-advance-overcenter-host.js';
import { createProjectAdvancePromotionRuntime } from './project-advance-promotion-runtime.js';
import { createPostgresProjectTransitionAuthoritativeEffectConfirmationService } from './project-transition-authoritative-effect-github-runtime.js';
import { createPostgresSubjectAwareOrchestrationRunService } from './orchestration-finish-runtime.js';
import {
  createPostgresOrchestrationAdvanceService,
  createPostgresProjectTransitionLeaseService,
  createPostgresTargetAwareOrchestrationRunService,
} from './orchestration-run-target-runtime.js';

export function createPostgresProjectAdvanceRuntime(options = {}) {
  const db = options.db;
  if (!db || typeof db !== 'object') throw new TypeError('database provider is required');
  const withGitHubAppApiClient = options.githubAppAuth?.withApiClient || options.withGitHubAppApiClient;
  const providerOptions = {
    ...options,
    db,
    ...(typeof withGitHubAppApiClient === 'function' ? { withGitHubAppApiClient } : {}),
  };
  const projectTransitions = options.projectTransitions || createPostgresProjectTransitionLeaseService(providerOptions);
  const runs = options.orchestrationRuns || createPostgresTargetAwareOrchestrationRunService(providerOptions);
  const advance = options.orchestrationAdvance || createPostgresOrchestrationAdvanceService({ ...providerOptions, projectTransitions });
  const finish = options.orchestrationFinish || Object.freeze({
    finish:(request) => createPostgresSubjectAwareOrchestrationRunService(providerOptions).finish(request),
  });
  const confirmAuthoritativeEffect = async (request) => {
    const authoritativeEffect = options.projectTransitionAuthoritativeEffect
      || createPostgresProjectTransitionAuthoritativeEffectConfirmationService(providerOptions);
    return authoritativeEffect.confirm(request);
  };
  const host = projectAdvanceFor({ db, runs, advance, finish, confirmAuthoritativeEffect });
  return createProjectAdvancePromotionRuntime({ host, projectTransitions });
}
