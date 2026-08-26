import { api, db } from 'hatchable';
import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { createLinearAuthority, executionProjection } from 'lib/work-leases.js';
import { repositoryIdentity } from 'lib/work-identity.js';

export class ExecutionAuthorityError extends Error {
  constructor(code, message, details = null, httpStatus = 409) {
    super(message);
    this.name = 'ExecutionAuthorityError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = 409) {
  throw new ExecutionAuthorityError(code, message, details, httpStatus);
}

function parseJson(value) {
  if (value === null || value === undefined || typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function instant(value) {
  const milliseconds = Date.parse(String(value || ''));
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function projectionMatchesExpected(current, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return false;
  const comparable = {};
  for (const key of Object.keys(expected)) comparable[key] = current?.[key];
  return canonicalJson(comparable) === canonicalJson(expected);
}

function projectionDiff(expected, current) {
  const keys = [...new Set([...Object.keys(expected || {}), ...Object.keys(current || {})])].sort();
  return keys.filter(key => canonicalJson(expected?.[key]) !== canonicalJson(current?.[key]));
}

export function createExecutionAuthorityService({ store, authoritative, now = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.getLeaseByTokenHash !== 'function' || typeof store.getSlot !== 'function' || typeof store.getRun !== 'function') {
    throw new Error('execution authority store must provide lease, slot, and run reads');
  }
  if (!authoritative || typeof authoritative.getIssue !== 'function') {
    throw new Error('execution authority requires authoritative work reads');
  }

  return {
    async require(input = {}) {
      const leaseToken = typeof input.lease_token === 'string' ? input.lease_token.trim() : '';
      if (!leaseToken) {
        fail('EXECUTION_AUTHORITY_REQUIRED', 'an active Busbar work lease is required for this mutation', {
          repository: repositoryIdentity(input.repository) || null,
        });
      }
      if (leaseToken.length > 256) {
        fail('EXECUTION_AUTHORITY_INVALID', 'execution authority token is malformed');
      }

      const allowedGates = new Set(Array.isArray(input.allowed_gates) ? input.allowed_gates.map(value => String(value)) : []);
      if (allowedGates.size === 0) throw new Error('execution authority allowed_gates must be non-empty');

      let lease;
      try {
        lease = await store.getLeaseByTokenHash(await sha256Text(leaseToken));
      } catch (error) {
        fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Busbar could not read execution authority state', {
          phase: 'lease_read',
          upstream_code: error?.code || null,
        }, 503);
      }
      if (!lease) fail('EXECUTION_AUTHORITY_INVALID', 'execution authority token is unknown');

      const observedNow = instant(now());
      if (observedNow === null) throw new Error('execution authority clock returned an invalid instant');
      const leaseExpiry = instant(lease.expires_at);
      const hardExpiry = lease.hard_expires_at ? instant(lease.hard_expires_at) : null;
      if (lease.status !== 'active' || leaseExpiry === null || leaseExpiry <= observedNow || (hardExpiry !== null && hardExpiry <= observedNow)) {
        fail('EXECUTION_AUTHORITY_STALE', 'execution authority lease is not active', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          reason: lease.status !== 'active' ? 'lease_status' : 'lease_expired',
        });
      }

      if (!allowedGates.has(lease.gate)) {
        fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'execution authority does not cover this mutation gate', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          allowed_gates: [...allowedGates].sort(),
        });
      }

      let slot;
      let run;
      try {
        [slot, run] = await Promise.all([
          store.getSlot(lease.work_ref, lease.gate),
          store.getRun(lease.run_id),
        ]);
      } catch (error) {
        fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Busbar could not confirm current execution ownership', {
          phase: 'ownership_read',
          upstream_code: error?.code || null,
        }, 503);
      }
      const slotExpiry = instant(slot?.expires_at);
      if (!slot || slot.lease_id !== lease.lease_id || slotExpiry === null || slotExpiry <= observedNow) {
        fail('EXECUTION_AUTHORITY_STALE', 'execution authority no longer owns the active work slot', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          reason: 'slot_not_owned',
        });
      }

      const runDeadline = instant(run?.deadline_at);
      if (!run || run.status !== 'active' || runDeadline === null || runDeadline <= observedNow) {
        fail('EXECUTION_AUTHORITY_STALE', 'execution authority run is no longer active', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          run_id: lease.run_id || null,
          gate: lease.gate || null,
          reason: 'run_not_active',
        });
      }

      const claimReceipt = parseJson(lease.claim_receipt);
      const claimProjection = claimReceipt?.execution_projection;
      if (!claimProjection || typeof claimProjection !== 'object' || Array.isArray(claimProjection)) {
        fail('EXECUTION_AUTHORITY_INVALID', 'execution authority lacks a durable execution projection', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
        });
      }

      const requestedRepository = repositoryIdentity(input.repository);
      const leaseRepository = repositoryIdentity(claimProjection.repository);
      if (!requestedRepository || !leaseRepository || requestedRepository !== leaseRepository) {
        fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'execution authority does not cover the requested repository', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          repository: requestedRepository || null,
          authorized_repository: leaseRepository || null,
        });
      }

      let issue;
      try {
        issue = await authoritative.getIssue(lease.work_ref);
      } catch (error) {
        fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Busbar could not re-read authoritative work state', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          phase: 'authoritative_work_read',
          upstream_code: error?.code || null,
        }, 503);
      }
      const currentProjection = executionProjection(issue);
      if (!projectionMatchesExpected(currentProjection, claimProjection)) {
        fail('EXECUTION_AUTHORITY_STALE', 'authoritative work state changed after the lease was claimed', {
          work_ref: lease.work_ref || null,
          lease_id: lease.lease_id || null,
          gate: lease.gate || null,
          reason: 'work_state_changed',
          changed_fields: projectionDiff(claimProjection, currentProjection),
        });
      }

      return {
        work_ref: lease.work_ref,
        lease_id: lease.lease_id,
        run_id: lease.run_id,
        gate: lease.gate,
        repository: leaseRepository,
        execution_fingerprint: claimReceipt?.execution_fingerprint || null,
      };
    },
  };
}

export function createPostgresExecutionAuthorityStore(dbBinding = db) {
  async function row(sql, params) {
    const result = await dbBinding.query(sql, params);
    return result.rows?.[0] || null;
  }
  return {
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
    now: options.now,
  });
}