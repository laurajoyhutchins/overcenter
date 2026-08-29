import { db as hatchableDb } from 'hatchable';
import { createCompatibilityTransitionConfirmationRuntime } from './compatibility-transition-confirmation-runtime.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from './project-transition-leases.js';

export function createHatchableCompatibilityTransitionConfirmationRuntime(options = {}) {
  const dbBinding = options.db || hatchableDb;
  const readProjectGraph = options.readProjectGraph || createAuthoritativeProjectGraphReader(
    createGitHubProjectGraphRuntime({ db:dbBinding }),
  );
  const projectTransitions = options.projectTransitions || createProjectTransitionLeaseService({
    store:createProjectTransitionLeasePostgresStore(dbBinding),
    readProjectGraph,
  });
  return createCompatibilityTransitionConfirmationRuntime({
    ...options,
    db:dbBinding,
    readProjectGraph,
    projectTransitions,
  });
}