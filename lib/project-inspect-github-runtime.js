import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from './project-transition-leases.js';
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

function revisionOf(graph) {
  return String(graph?.authority?.definition?.revision || '').trim().toLowerCase();
}

export function projectInspectForGitHub(options = {}) {
  const db = options.db;
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  const createGitHubProjectGraphRuntime = options.createGitHubProjectGraphRuntime;
  const createProjectTransitionLeaseStore = options.createProjectTransitionLeaseStore || createProjectTransitionLeasePostgresStore;
  if (typeof createGitHubProjectGraphRuntime !== 'function') {
    invalid('project.inspect GitHub runtime factory is unavailable');
  }
  if (typeof withGitHubAppApiClient !== 'function') {
    invalid('project.inspect GitHub auth provider is unavailable');
  }
  return Object.freeze({
    async inspect(input) {
      const graphRuntime = createGitHubProjectGraphRuntime({ db, withGitHubAppApiClient });
      const authoritativeReader = createAuthoritativeProjectGraphReader(graphRuntime);
      let snapshotPromise = null;
      const readSnapshot = (request) => {
        if (!snapshotPromise) snapshotPromise = authoritativeReader(request);
        return snapshotPromise;
      };
      const leaseStore = createProjectTransitionLeaseStore(db);
      const transitions = createProjectTransitionLeaseService({ store:leaseStore, readProjectGraph:readSnapshot });
      const inspect = projectInspectFor({
        readProjectGraph:readSnapshot,
        async readTransitionOccupancy({ project_ref, transition_id, authority_revision, observed_at }) {
          const graph = await readSnapshot({ project_ref });
          if (revisionOf(graph) !== authority_revision) {
            invalid('project.inspect transition decision snapshot drifted from graph authority');
          }
          const [active, suspended] = await Promise.all([
            leaseStore.getActiveLeasesForTransition(project_ref, transition_id, observed_at),
            transitions.isSuspended({ project_ref, transition_id }),
          ]);
          const lease = active[0] || null;
          return Object.freeze({
            occupied:Boolean(lease),
            expires_at:timestamp(lease?.expires_at),
            suspended:Boolean(suspended),
            suspension_reason:suspended ? 'blocked_settlement_promotion' : null,
          });
        },
      });
      return inspect.inspect(input);
    },
  });
}