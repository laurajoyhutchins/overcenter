import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { projectInspectFor } from './project-inspect-overcenter-host.js';

function invalid(message) {
  const error = new Error(message);
  error.code = 'PROJECT_INSPECT_RUNTIME_INVALID';
  throw error;
}

export function projectInspectForGitHub(options = {}) {
  const db = options.db;
  const createGitHubProjectGraphRuntime = options.createGitHubProjectGraphRuntime;
  const createProjectTransitionLeaseStore = options.createProjectTransitionLeaseStore || createProjectTransitionLeasePostgresStore;
  if (typeof createGitHubProjectGraphRuntime !== 'function') {
    invalid('project.inspect GitHub runtime factory is unavailable');
  }
  return Object.freeze({
    async inspect(input) {
      const graphRuntime = createGitHubProjectGraphRuntime({ db });
      const leaseStore = createProjectTransitionLeaseStore(db);
      const inspect = projectInspectFor({
        readProjectGraph:createAuthoritativeProjectGraphReader(graphRuntime),
        activeLeasesForTransition:(projectRef, transitionId, observedAt) =>
          leaseStore.getActiveLeasesForTransition(projectRef, transitionId, observedAt),
      });
      return inspect.inspect(input);
    },
  });
}