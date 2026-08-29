import { api, db } from 'hatchable';
import { ExecutionAuthorityError, createExecutionAuthorityService as createExecutionAuthorityCoreService } from './execution-authority-core.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from './project-transition-leases.js';
import { createLinearAuthority, executionProjection } from './work-leases.js';

export { ExecutionAuthorityError };

export function createExecutionAuthorityService(options = {}) {
  return createExecutionAuthorityCoreService({
    ...options,
    executionProjection: options.executionProjection || executionProjection,
  });
}

export function createPostgresExecutionAuthorityStore(dbBinding = db) {
  async function row(sql, params) {
    const result = await dbBinding.query(sql, params);
    return result.rows?.[0] || null;
  }
  return {
    getLeaseById(leaseId) {
      return row(
        `SELECT lease_id, work_ref, gate, run_id, status, expires_at, hard_expires_at, claim_receipt
           FROM work_leases
          WHERE lease_id = $1
          LIMIT 1`,
        [leaseId],
      );
    },
    getLeaseByTokenHash(tokenHash) {
      return row(
        `SELECT lease_id, work_ref, gate, run_id, status, expires_at, hard_expires_at, claim_receipt
           FROM work_leases
          WHERE token_hash = $1
          LIMIT 1`,
        [tokenHash],
      );
    },
    getSlot(workRef, gate) {
      return row(
        `SELECT work_ref, gate, lease_id, expires_at
           FROM work_lease_slots
          WHERE work_ref = $1 AND gate = $2
          LIMIT 1`,
        [workRef, gate],
      );
    },
    getRun(runId) {
      return row(
        `SELECT run_id, status, deadline_at
           FROM orchestration_runs
          WHERE run_id = $1
          LIMIT 1`,
        [runId],
      );
    },
  };
}

function projectTransitionsFor(options, dbBinding) {
  if (options.projectTransitions && typeof options.projectTransitions.require === 'function') {
    return options.projectTransitions;
  }
  const graphRuntime = options.projectGraphRuntime || createGitHubProjectGraphRuntime({ ...options, db:dbBinding });
  const readProjectGraph = typeof options.projectGraphReader === 'function'
    ? options.projectGraphReader
    : createAuthoritativeProjectGraphReader(graphRuntime);
  const store = options.projectTransitionStore || createProjectTransitionLeasePostgresStore(dbBinding);
  return createProjectTransitionLeaseService({ store, readProjectGraph, now:options.now });
}

export function createPostgresExecutionAuthorityService(options = {}) {
  const dbBinding = options.db || db;
  return createExecutionAuthorityService({
    store: options.store || createPostgresExecutionAuthorityStore(dbBinding),
    authoritative: options.authoritative || createLinearAuthority(options.api || api),
    executionProjection: options.executionProjection || executionProjection,
    projectTransitions: projectTransitionsFor(options, dbBinding),
    now: options.now,
  });
}