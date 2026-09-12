// Database and API providers are injected by the runtime composition root.
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

function canonicalProjectTransitionLease(row) {
  const lifecycle = String(row?.lifecycle || '').trim();
  const status = lifecycle === 'executing'
    ? 'active'
    : lifecycle === 'settled'
      ? 'settled'
      : lifecycle === 'rejected'
        ? 'rejected'
        : 'invalidated';
  const authorityEpoch = Number(row?.authority_epoch || 0);
  const subjectKey = String(row?.subject_key || '');
  const leaseId = String(row?.lease_id || row?.lease_ref || '');
  return {
    lease_id:leaseId,
    work_ref:subjectKey,
    gate:'project_transition',
    run_id:row?.run_id == null ? null : String(row.run_id),
    status,
    expires_at:row?.expires_at || null,
    hard_expires_at:row?.hard_expires_at || null,
    claim_receipt:{
      schema:'project-transition-lease-claim-v1',
      subject:'project_transition',
      project_transition:{
        project_ref:String(row?.project_ref || ''),
        transition_id:String(row?.transition_id || ''),
        repository:String(row?.authority_repository || ''),
        authority_revision:String(row?.authority_revision || '').toLowerCase(),
        authority_derivation:String(row?.authority_derivation || ''),
        graph_fingerprint:String(row?.graph_fingerprint || ''),
        transition_definition_fingerprint:String(row?.transition_definition_fingerprint || ''),
        transition_revision_fingerprint:String(row?.transition_revision_fingerprint || ''),
        transition_dependency_fingerprint:String(row?.transition_dependency_fingerprint || ''),
        slot_key:subjectKey,
        authority_epoch:authorityEpoch,
      },
      execution_id:row?.execution_id == null ? null : String(row.execution_id),
      operation_id:row?.operation_id == null ? null : String(row.operation_id),
      intent_sha256:row?.intent_sha256 == null ? null : String(row.intent_sha256),
    },
    execution_id:row?.execution_id == null ? null : String(row.execution_id),
    operation_id:row?.operation_id == null ? null : String(row.operation_id),
    authority_epoch:authorityEpoch,
    settlement_receipt:row?.settlement_receipt || null,
  };
}
export function createPostgresExecutionAuthorityStore(dbBinding) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new ExecutionAuthorityError('RUNTIME_PROVIDER_MISSING', 'database provider is required', { provider:'db' });
  async function row(sql, params) {
    const result = await dbBinding.query(sql, params);
    return result.rows?.[0] || null;
  }
  return {
    async getLeaseById(leaseId) {
      const canonical = await row(
        `SELECT e.lease_ref::text AS lease_id,
                e.subject_key,
                e.subject_kind,
                e.execution_id,
                e.operation_id,
                e.project_ref,
                e.transition_id,
                e.run_id,
                e.lifecycle,
                e.settled,
                e.authority_epoch,
                e.authority_repository,
                e.authority_revision,
                e.authority_derivation,
                e.graph_fingerprint,
                e.transition_definition_fingerprint,
                e.transition_revision_fingerprint,
                e.transition_dependency_fingerprint,
                e.expires_at,
                e.hard_expires_at,
                e.settlement_receipt,
                e.intent_sha256
           FROM execution_state e
          WHERE e.lease_ref = $1
            AND e.subject_kind = 'project_transition'
          LIMIT 1`,
        [leaseId],
      );
      if (canonical) return canonicalProjectTransitionLease(canonical);
      return row(
        `SELECT lease_id, work_ref, gate, run_id, status, expires_at, hard_expires_at, claim_receipt
           FROM work_leases
          WHERE lease_id = $1
          LIMIT 1`,
        [leaseId],
      );
    },    getLeaseByTokenHash(tokenHash) {
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
  const dbBinding = options.db;
  const apiBinding = options.api;
  if (!options.store && (!dbBinding || typeof dbBinding.query !== 'function')) throw new ExecutionAuthorityError('RUNTIME_PROVIDER_MISSING', 'database provider is required', { provider:'db' });
  if (!options.authoritative && (!apiBinding || typeof apiBinding.call !== 'function')) throw new ExecutionAuthorityError('RUNTIME_PROVIDER_MISSING', 'API provider is required', { provider:'api' });
  return createExecutionAuthorityService({
    store: options.store || createPostgresExecutionAuthorityStore(dbBinding),
    authoritative: options.authoritative || createLinearAuthority(apiBinding),
    executionProjection: options.executionProjection || executionProjection,
    projectTransitions: projectTransitionsFor(options, dbBinding),
    now: options.now,
  });
}