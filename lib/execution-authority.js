import { api, db } from 'hatchable';
import { ExecutionAuthorityError, createExecutionAuthorityService as createExecutionAuthorityCoreService } from './execution-authority-core.js';
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

export function createPostgresExecutionAuthorityService(options = {}) {
  return createExecutionAuthorityService({
    store: options.store || createPostgresExecutionAuthorityStore(options.db || db),
    authoritative: options.authoritative || createLinearAuthority(options.api || api),
    executionProjection: options.executionProjection || executionProjection,
    now: options.now,
  });
}