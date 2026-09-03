import { api, db } from 'hatchable';
import { canonicalJson, sha256Text } from './canonical-json.js';
import { LIVE_LEASE_STATUSES } from './execution-lifecycle-contracts.js';
import { createPostgresOrchestrationRunService, createPostgresOrchestrationRunStore } from './orchestration-runs.js';
import { createAuthoritativeProjectGraphReader } from './project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from './project-graph-github-runtime.js';
import { createProjectTransitionLeasePostgresStore } from './project-transition-lease-store.js';
import { createProjectTransitionLeaseService } from './project-transition-leases.js';
import { createPostgresRepositoryLifecycleService } from './repository-disposition.js';
import { createPostgresWorkLeaseService } from './work-leases.js';
import { createSubjectAwareActiveLeaseStore as createAuthorityAwareActiveLeaseStore, durableLeaseSubject } from './orchestration-lease-authority.js';

const LIVE_LEASE_STATUS_SQL = LIVE_LEASE_STATUSES.map((status) => `'${status}'`).join(',');

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function projectTransitionsFor(options, dbBinding) {
  if (options.projectTransitions && typeof options.projectTransitions.settle === 'function' && typeof options.projectTransitions.require === 'function') return options.projectTransitions;
  const graphRuntime = options.projectGraphRuntime || createGitHubProjectGraphRuntime({ ...options, db:dbBinding });
  const readProjectGraph = typeof options.projectGraphReader === 'function'
    ? options.projectGraphReader
    : createAuthoritativeProjectGraphReader(graphRuntime);
  const store = options.projectTransitionStore || createProjectTransitionLeasePostgresStore(dbBinding);
  return createProjectTransitionLeaseService({ store, readProjectGraph, now:options.now });
}

function durableSubject(lease) {
  return durableLeaseSubject(lease);
}

export const createSubjectAwareActiveLeaseStore = createAuthorityAwareActiveLeaseStore;

export function createSubjectAwareLeaseCheckpointService({ readLease, legacyLeases, projectTransitions } = {}) {
  if (typeof readLease !== 'function') throw new TypeError('readLease is required');
  if (!legacyLeases || typeof legacyLeases.checkpointByRef !== 'function') throw new TypeError('legacyLeases.checkpointByRef is required');
  if (!projectTransitions || typeof projectTransitions.checkpoint !== 'function') throw new TypeError('projectTransitions.checkpoint is required');

  async function checkpointByRef(input = {}) {
    const leaseRef = typeof input.lease_ref === 'string' ? input.lease_ref.trim() : '';
    if (!leaseRef) fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'lease_ref is required');
    const lease = await readLease(leaseRef);
    const subject = durableSubject(lease);
    if (subject === 'legacy_work') return legacyLeases.checkpointByRef(input);

    const runId = typeof lease.run_id === 'string' ? lease.run_id.trim() : '';
    if (!runId) fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'project transition lease is missing durable run identity', { lease_ref:leaseRef });
    return projectTransitions.checkpoint({
      lease_ref:leaseRef,
      run_id:runId,
      checkpoint:input.checkpoint,
      idempotency_key:input.idempotency_key,
    });
  }

  return Object.freeze({ checkpointByRef });
}

export function createSubjectAwareLeaseHeartbeatService({ readLease, legacyLeases, projectTransitions } = {}) {
  if (typeof readLease !== 'function') throw new TypeError('readLease is required');
  if (!legacyLeases || typeof legacyLeases.heartbeatByRef !== 'function') throw new TypeError('legacyLeases.heartbeatByRef is required');
  if (!projectTransitions || typeof projectTransitions.heartbeat !== 'function') throw new TypeError('projectTransitions.heartbeat is required');

  async function heartbeatByRef(input = {}) {
    const leaseRef = typeof input.lease_ref === 'string' ? input.lease_ref.trim() : '';
    if (!leaseRef) fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'lease_ref is required');
    const lease = await readLease(leaseRef);
    const subject = durableSubject(lease);
    if (subject === 'legacy_work') return legacyLeases.heartbeatByRef(input);

    const runId = typeof lease.run_id === 'string' ? lease.run_id.trim() : '';
    if (!runId) fail('ORCHESTRATION_LEASE_SUBJECT_INVALID', 'project transition lease is missing durable run identity', { lease_ref:leaseRef });
    return projectTransitions.heartbeat({
      lease_ref:leaseRef,
      run_id:runId,
      extend_seconds:input.extend_seconds,
      checkpoint:input.checkpoint ?? null,
      idempotency_key:input.idempotency_key,
    });
  }

  return Object.freeze({ heartbeatByRef });
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
      evidence:input.evidence,
      reason:input.reason,
      idempotency_key:input.idempotency_key,
    });
  }

  return Object.freeze({ settleByRef });
}

function readLeaseByRef(dbBinding) {
  return async (leaseRef) => {
    const result = await dbBinding.query(
      `SELECT lease_id, run_id, gate, claim_receipt
         FROM work_leases
        WHERE lease_id = $1
        LIMIT 1`,
      [leaseRef],
    );
    return result.rows?.[0] || null;
  };
}

export function createPostgresSubjectAwareLeaseCheckpointService(options = {}) {
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
  const projectTransitions = projectTransitionsFor(options, dbBinding);
  return createSubjectAwareLeaseCheckpointService({
    readLease:options.readLease || readLeaseByRef(dbBinding),
    legacyLeases,
    projectTransitions:options.projectTransitionCheckpoint || projectTransitions,
  });
}

export function createPostgresSubjectAwareLeaseHeartbeatService(options = {}) {
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
  return createSubjectAwareLeaseHeartbeatService({
    readLease:options.readLease || readLeaseByRef(dbBinding),
    legacyLeases,
    projectTransitions:options.projectTransitions || projectTransitionsFor(options, dbBinding),
  });
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
  return createSubjectAwareLeaseSettlementService({
    readLease:options.readLease || readLeaseByRef(dbBinding),
    legacyLeases,
    projectTransitions:options.projectTransitions || projectTransitionsFor(options, dbBinding),
  });
}

function readActiveLeaseCandidates(dbBinding) {
  return async (runId, observedAt) => {
    const result = await dbBinding.query(
      `SELECT lease_id,work_ref,gate,run_id,status,created_at,expires_at,claim_receipt
         FROM work_leases
        WHERE run_id=$1 AND status IN (${LIVE_LEASE_STATUS_SQL}) AND expires_at > $2
        ORDER BY created_at DESC, lease_id DESC`,
      [runId, observedAt],
    );
    return result.rows || [];
  };
}

export function createPostgresSubjectAwareOrchestrationRunService(options = {}) {
  const dbBinding = options.db || db;
  const projectTransitions = projectTransitionsFor(options, dbBinding);
  const baseStore = options.store || createPostgresOrchestrationRunStore(dbBinding);
  const store = createAuthorityAwareActiveLeaseStore({
    store:baseStore,
    projectTransitions,
    readCandidates:options.readActiveLeaseCandidates || readActiveLeaseCandidates(dbBinding),
  });
  const leases = options.leases || createPostgresSubjectAwareLeaseSettlementService({ ...options, db:dbBinding, projectTransitions });
  return createPostgresOrchestrationRunService({ ...options, db:dbBinding, store, leases });
}