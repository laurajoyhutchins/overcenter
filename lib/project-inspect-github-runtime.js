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

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function exactSha(value) {
  const revision = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(revision) ? revision : null;
}

function canonicalAuthoringOperation(row) {
  const facts = jsonObject(row.response_facts);
  const evidence = jsonObject(facts.evidence);
  const transition = String(row.transition_fingerprint || '');
  const operation = transition.startsWith('project-authoring:define:')
    ? 'define'
    : (transition.startsWith('project-authoring:amend:') ? 'amend' : null);
  if (!operation) return null;
  const command = `project.${operation}`;
  const state = row.lifecycle === 'settled'
    ? 'succeeded'
    : (row.lifecycle === 'effect_uncertain' || row.operation_state === 'indeterminate'
      ? 'indeterminate'
      : String(row.operation_state || 'prepared'));
  const expectedRevision = exactSha(row.authority_revision);
  const stagedRevision = exactSha(
    evidence.revision || evidence.new_head || evidence.commit_sha
      || facts.revision || facts.new_head || facts.commit_sha,
  );
  const idempotencyKey = String(
    evidence.idempotency_key || facts.idempotency_key || row.idempotency_key || row.execution_id,
  ).trim();
  const phase = state === 'succeeded'
    ? 'READY'
    : (state === 'indeterminate' ? 'INDETERMINATE_EXTERNAL_EFFECT' : 'WAITING_EXTERNAL_VERIFICATION');
  const payload = {
    command,
    project_ref:row.project_ref,
    idempotency_key:idempotencyKey,
    expected_revision:expectedRevision,
    staged_revision:stagedRevision,
    pull_request:Number.isInteger(Number(evidence.pull_request)) ? Number(evidence.pull_request) : null,
    phase,
    waiting_on:Array.isArray(evidence.waiting_on) ? evidence.waiting_on : [],
  };
  return {
    canonical_execution:true,
    operation_id:String(row.operation_id),
    idempotency_key:idempotencyKey,
    state,
    recovery_payload:payload,
    resolution:state === 'succeeded' ? { authoring:payload } : null,
  };
}

async function readCanonicalAuthoringOperations(db, projectRef) {
  if (!db || typeof db.query !== 'function') return [];
  const result = await db.query(
    `SELECT e.execution_id, e.project_ref, e.authority_revision,
            e.transition_revision_fingerprint AS transition_fingerprint,
            e.lifecycle, o.operation_id, o.idempotency_key,
            o.state AS operation_state, o.response_facts
       FROM execution_state e
       JOIN operation_state o ON o.execution_id = e.execution_id
      WHERE e.project_ref = $1
        AND e.operation_kind = 'project.authoring'
        AND e.lifecycle NOT IN ('rejected')
      ORDER BY e.updated_at DESC, o.operation_id
      LIMIT 8`,
    [projectRef],
  );
  return (result?.rows || []).map(canonicalAuthoringOperation).filter(Boolean);
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
        readAuthoringOperations({ project_ref, authority_revision }) {
          return readCanonicalAuthoringOperations(db, project_ref, authority_revision);
        },
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