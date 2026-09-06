import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { projectTransitionBlockedSettlementSuspends } from './project-transition-leases.js';
import { projectInspectFor } from './project-inspect-overcenter-host.js';

function invalid(message) {
  const error = new Error(message);
  error.code = 'PROJECT_INSPECT_RUNTIME_INVALID';
  throw error;
}

function timestamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
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
        async readTransitionOccupancy({ project_ref, transition_id, authority_revision, observed_at, transition }) {
          const [active, latestSettled] = await Promise.all([
            leaseStore.getActiveLeasesForTransition(project_ref, transition_id, observed_at, authority_revision),
            leaseStore.getLatestSettledLeaseForTransition(project_ref, transition_id, observed_at),
          ]);
          const lease = active[0] || null;
          const suspended = await projectTransitionBlockedSettlementSuspends(latestSettled, transition);
          return Object.freeze({
            occupied:Boolean(lease),
            expires_at:timestamp(lease?.expires_at),
            suspended,
            suspension_reason:suspended ? 'blocked_settlement_promotion' : null,
          });
        },
      });
      return inspect.inspect(input);
    },
  });
}