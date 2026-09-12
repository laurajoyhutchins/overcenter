// Database and API providers are injected by the runtime composition root.
import { canonicalJson, sha256Text } from './canonical-json.js';
import { assertSettlementReceipt } from './execution-transaction.js';
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

export function createSubjectAwareLeaseSettlementService({ readLease, legacyLeases, projectTransitions, requireCanonicalReceipt = false } = {}) {
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
    const settlement = await projectTransitions.settle({
      lease_ref:leaseRef,
      run_id:runId,
      disposition:input.disposition,
      evidence:input.evidence,
      reason:input.reason,
      promotion_condition:input.promotion_condition,
      idempotency_key:input.idempotency_key,
    });
    if (requireCanonicalReceipt) {
      try {
        assertSettlementReceipt(settlement?.settlement_receipt);
      } catch (error) {
        fail('CANONICAL_SETTLEMENT_RECEIPT_REQUIRED', 'project-transition settlement did not return a valid canonical settlement receipt', {
          lease_ref:leaseRef,
          cause:String(error?.message || error),
        });
      }
    }
    return settlement;
  }

  return Object.freeze({ settleByRef });
}

function readLeaseByRef(dbBinding) {
  return async (leaseRef) => {
    const canonical = await dbBinding.query(
      `SELECT e.lease_ref::text AS lease_id,
                e.subject_key,e.run_id,e.project_ref,e.transition_id,
                e.authority_repository,e.authority_revision,e.authority_derivation,
                e.graph_fingerprint,e.transition_definition_fingerprint,
                e.transition_revision_fingerprint,e.transition_dependency_fingerprint,
                e.lease_epoch,e.authority_epoch,e.expires_at,e.hard_expires_at,
                e.execution_id,e.operation_id,e.lifecycle AS execution_lifecycle,
                e.settled AS execution_settled,e.settlement_receipt
           FROM execution_state e
          WHERE e.lease_ref=$1
            AND e.subject_kind='project_transition'
          LIMIT 1`,
      [leaseRef],
    );
    const execution = canonical.rows?.[0] || null;
    if (execution) {
      return {
        lease_id:execution.lease_id,
        work_ref:execution.subject_key,
        gate:'project_transition',
        run_id:execution.run_id,
        subject_kind:'project_transition',
        execution_id:execution.execution_id,
        operation_id:execution.operation_id,
        lease_epoch:execution.lease_epoch,
        authority_epoch:execution.authority_epoch,
        execution_lifecycle:execution.execution_lifecycle,
        execution_settled:execution.execution_settled,
        expires_at:execution.expires_at,
        hard_expires_at:execution.hard_expires_at,
        settlement_receipt:execution.settlement_receipt,
        claim_receipt:{
          schema:'project-transition-lease-claim-v1',
          subject:'project_transition',
          project_transition:{
            project_ref:execution.project_ref,
            transition_id:execution.transition_id,
            repository:execution.authority_repository,
            authority_revision:execution.authority_revision,
            authority_derivation:execution.authority_derivation,
            graph_fingerprint:execution.graph_fingerprint,
            transition_definition_fingerprint:execution.transition_definition_fingerprint,
            transition_revision_fingerprint:execution.transition_revision_fingerprint,
            transition_dependency_fingerprint:execution.transition_dependency_fingerprint,
            slot_key:execution.subject_key,
            authority_epoch:Number(execution.authority_epoch || 0),
          },
        },
      };
    }
    const result = await dbBinding.query(
      `SELECT l.lease_id, l.run_id, l.gate, l.claim_receipt,
                e.subject_kind, e.execution_id, e.operation_id,
                e.lease_epoch, e.authority_epoch, e.lifecycle AS execution_lifecycle,
                e.settled AS execution_settled, e.settlement_receipt
           FROM work_leases l
           LEFT JOIN execution_state e
             ON e.subject_key=l.work_ref AND e.lease_ref=l.lease_id
          WHERE l.lease_id = $1
          LIMIT 1`,
      [leaseRef],
    );
    return result.rows?.[0] || null;
  };
}

export function createPostgresSubjectAwareLeaseCheckpointService(options = {}) {
  const dbBinding = options.db;
  const apiBinding = options.api;
  if (!dbBinding || typeof dbBinding.query !== 'function') fail('RUNTIME_PROVIDER_MISSING', 'database provider is required', { provider:'db' });
  const repositoryLifecycle = options.repositoryLifecycle || createPostgresRepositoryLifecycleService({
    db:dbBinding,
    api:apiBinding,
    now:options.now,
  });
  const legacyLeases = options.legacyLeases || createPostgresWorkLeaseService({
    db:dbBinding,
    api:apiBinding,
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
  const dbBinding = options.db;
  const apiBinding = options.api;
  if (!dbBinding || typeof dbBinding.query !== 'function') fail('RUNTIME_PROVIDER_MISSING', 'database provider is required', { provider:'db' });
  const repositoryLifecycle = options.repositoryLifecycle || createPostgresRepositoryLifecycleService({
    db:dbBinding,
    api:apiBinding,
    now:options.now,
  });
  const legacyLeases = options.legacyLeases || createPostgresWorkLeaseService({
    db:dbBinding,
    api:apiBinding,
    repositoryLifecycle,
  });
  return createSubjectAwareLeaseHeartbeatService({
    readLease:options.readLease || readLeaseByRef(dbBinding),
    legacyLeases,
    projectTransitions:options.projectTransitions || projectTransitionsFor(options, dbBinding),
  });
}

export function createPostgresSubjectAwareLeaseSettlementService(options = {}) {
  const dbBinding = options.db;
  const apiBinding = options.api;
  if (!dbBinding || typeof dbBinding.query !== 'function') fail('RUNTIME_PROVIDER_MISSING', 'database provider is required', { provider:'db' });
  const repositoryLifecycle = options.repositoryLifecycle || createPostgresRepositoryLifecycleService({
    db:dbBinding,
    api:apiBinding,
    now:options.now,
  });
  const legacyLeases = options.legacyLeases || createPostgresWorkLeaseService({
    db:dbBinding,
    api:apiBinding,
    repositoryLifecycle,
  });
  return createSubjectAwareLeaseSettlementService({
    readLease:options.readLease || readLeaseByRef(dbBinding),
    legacyLeases,
    projectTransitions:options.projectTransitions || projectTransitionsFor(options, dbBinding),
    requireCanonicalReceipt:true,
  });
}

function readActiveLeaseCandidates(dbBinding) {
  return async (runId, observedAt) => {
    const result = await dbBinding.query(
      `SELECT l.lease_id,l.work_ref,l.gate,l.run_id,l.status,l.created_at,l.expires_at,l.claim_receipt,
                e.subject_kind,e.execution_id,e.operation_id,e.lease_epoch,e.authority_epoch,
                e.lifecycle AS execution_lifecycle,e.settled AS execution_settled,e.settlement_receipt
           FROM work_leases l
           LEFT JOIN execution_state e
             ON e.subject_key=l.work_ref AND e.lease_ref=l.lease_id
          WHERE l.run_id=$1 AND l.status IN (${LIVE_LEASE_STATUS_SQL}) AND l.expires_at > $2
            AND (
              COALESCE(l.claim_receipt->>'subject','legacy_work') <> 'project_transition'
              OR (
                e.subject_kind='project_transition'
                AND e.run_id=l.run_id
                AND e.lifecycle IN ('prepared','executing','effect_uncertain','effect_confirmed','effect_absent')
                AND e.settled=false
              )
            )
          ORDER BY l.created_at DESC, l.lease_id DESC`,
      [runId, observedAt],
    );
    return result.rows || [];
  };
}

export function createPostgresSubjectAwareOrchestrationRunService(options = {}) {
  const dbBinding = options.db;
  if (!dbBinding || typeof dbBinding.query !== 'function') fail('RUNTIME_PROVIDER_MISSING', 'database provider is required', { provider:'db' });
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