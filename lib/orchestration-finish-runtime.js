import { api, db } from 'hatchable';
import { createPostgresOrchestrationRunService } from './orchestration-runs.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from './project-transition-leases.js';
import { createPostgresRepositoryLifecycleService } from './repository-disposition.js';
import { createPostgresWorkLeaseService } from './work-leases.js';

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function projectTransitionsFor(options, dbBinding) {
  if (options.projectTransitions && typeof options.projectTransitions.settle === 'function') return options.projectTransitions;
  const graphRuntime = options.projectGraphRuntime || createGitHubProjectGraphRuntime({ ...options, db:dbBinding });
  const readProjectGraph = typeof options.projectGraphReader === 'function'
    ? options.projectGraphReader
    : createAuthoritativeProjectGraphReader(graphRuntime);
  const store = options.projectTransitionStore || createProjectTransitionLeasePostgresStore(dbBinding);
  return createProjectTransitionLeaseService({ store, readProjectGraph, now:options.now });
}

function durableSubject(lease) {
  if (!lease || typeof lease !== 'object' || Array.isArray(lease)) {
    fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'active lease authority is unavailable');
  }
  const gate = typeof lease.gate === 'string' ? lease.gate.trim() : '';
  const receiptSubject = typeof lease.claim_receipt?.subject === 'string'
    ? lease.claim_receipt.subject.trim().toLowerCase()
    : '';
  const gateIsProjectTransition = gate === 'project_transition';
  const receiptIsProjectTransition = receiptSubject === 'project_transition';

  if (gateIsProjectTransition !== receiptIsProjectTransition) {
    fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'durable lease subject evidence is ambiguous', {
      lease_ref:lease.lease_id || null,
      gate:gate || null,
      receipt_subject:receiptSubject || null,
    });
  }
  return gateIsProjectTransition ? 'project_transition' : 'legacy_work';
}

export function createSubjectAwareLeaseSettlementService({ readLease, legacyLeases, projectTransitions } = {}) {
  if (typeof readLease !== 'function') throw new TypeError('readLease is required');
  if (!legacyLeases || typeof legacyLeases.settleByRef !== 'function') throw new TypeError('legacyLeases.settleByRef is required');
  if (!projectTransitions || typeof projectTransitions.settle !== 'function') throw new TypeError('projectTransitions.settle is required');

  async function settleByRef(input = {}) {
    const leaseRef = typeof input.lease_ref === 'string' ? input.lease_ref.trim() : '';
    if (!leaseRef) fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'lease_ref is required');
    const lease = await readLease(leaseRef);
    const subject = durableSubject(lease);
    if (subject === 'legacy_work') return legacyLeases.settleByRef(input);

    const runId = typeof lease.run_id === 'string' ? lease.run_id.trim() : '';
    if (!runId) fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'project transition lease is missing durable run identity', { lease_ref:leaseRef });
    return projectTransitions.settle({
      lease_ref:leaseRef,
      run_id:runId,
      disposition:input.disposition,
      idempotency_key:input.idempotency_key,
    });
  }

  return Object.freeze({ settleByRef });
}

export function createPostgresSubjectAwareLeaseSettlementService(options = {}) {
  const dbBinding = options.db || db;
  const repositoryLifecycle = options.repositoryLifecycle || createPostgresRepositoryLifecycleService({
    db:dbBinding,
    api:options.api || api,
    now:options.now,
  });
  const legacyLeases = options.legacyLeases || createPostgresWorkLeaseService({
    db:dbBinding,
    api:options.api || api,
    repositoryLifecycle,
  });
  const readLease = options.readLease || (async (leaseRef) => {
    const result = await dbBinding.query(
      `SELECT lease_id, run_id, gate, claim_receipt
         FROM work_leases
        WHERE lease_id = $1
        LIMIT 1`,
      [leaseRef],
    );
    return result.rows?.[0] || null;
  });
  return createSubjectAwareLeaseSettlementService({
    readLease,
    legacyLeases,
    projectTransitions:projectTransitionsFor(options, dbBinding),
  });
}

export function createPostgresSubjectAwareOrchestrationRunService(options = {}) {
  const dbBinding = options.db || db;
  const leases = options.leases || createPostgresSubjectAwareLeaseSettlementService({ ...options, db:dbBinding });
  return createPostgresOrchestrationRunService({ ...options, db:dbBinding, leases });
}