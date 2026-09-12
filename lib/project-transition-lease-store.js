import { canonicalJson, sha256Text } from './canonical-json.js';

const IDEMPOTENCY_PREFIX = 'project-transition:';
const SETTLE_IDEMPOTENCY_PREFIX = 'project-transition-settle:';
const STORAGE_SCOPE = 'project_transition';
const CHECKPOINT_OPERATION = 'project_transition.checkpoint';
const HEARTBEAT_CHECKPOINT_OPERATION = 'project_transition.heartbeat_checkpoint';
const HEARTBEAT_OPERATION = 'project_transition.heartbeat';
const EXECUTION_FINGERPRINT_SCHEMA = 'project-transition-execution-fingerprint-v1';

function object(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function required(value, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw Object.assign(new Error(`${field} is required`), { code:'PROJECT_TRANSITION_LEASE_PERSISTENCE_INVALID' });
  return text;
}

function boundedRequired(value, field, max = 512) {
  const text = required(value, field);
  if (text.length > max) throw Object.assign(new Error(`${field} is too long`), { code:'PROJECT_TRANSITION_LEASE_PERSISTENCE_INVALID' });
  return text;
}

function optional(value, field, max = 512) {
  if (value === undefined || value === null || value === '') return null;
  return boundedRequired(String(value), field, max);
}

function settlementEvidence(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 50) throw Object.assign(new Error('evidence is invalid'), { code:'PROJECT_TRANSITION_LEASE_PERSISTENCE_INVALID' });
  return value.map((item, index) => ({
    kind:boundedRequired(item?.kind, `evidence[${index}].kind`, 128),
    ref:boundedRequired(item?.ref, `evidence[${index}].ref`, 1024),
  }));
}

function settlementPlan(disposition, source = {}) {
  return {
    schema:'project-transition-lease-settlement-plan-v1',
    subject:'project_transition',
    disposition,
    evidence:settlementEvidence(source.evidence),
    reason:optional(source.reason, 'reason', 2000),
    promotion_condition:optional(source.promotion_condition, 'promotion_condition', 2000),
  };
}

function epoch(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function optionalEpoch(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error('authority_epoch is invalid'), { code:'PROJECT_TRANSITION_LEASE_PERSISTENCE_INVALID' });
  }
  return parsed;
}

function uuidFromHash(hash) {
  const hex = hash.replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = '8';
  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20, 32).join(''),
  ].join('-');
}

async function projectTransitionExecutionIdentity({
  subjectKey,
  projectRef,
  transitionId,
  repository,
  authorityRevision,
  graphFingerprint,
  transitionDefinitionFingerprint,
  transitionRevisionFingerprint,
  transitionDependencyFingerprint,
  acquireIdempotencyKey,
  acquireRequestHash,
  authorityEpoch,
}) {
  const executionHash = await sha256Text(canonicalJson({
    schema:'project-transition-execution-id-v1',
    subject_key:subjectKey,
  }));
  const intent = {
    schema:'project-transition-execution-intent-v1',
    subject:'project_transition',
    project_ref:projectRef,
    subject_key:subjectKey,
    transition_id:transitionId,
    authority:{
      repository,
      revision:authorityRevision,
      epoch:authorityEpoch,
      graph_fingerprint:graphFingerprint,
      transition_definition_fingerprint:transitionDefinitionFingerprint,
      transition_revision_fingerprint:transitionRevisionFingerprint,
      transition_dependency_fingerprint:transitionDependencyFingerprint,
    },
    operation:{
      kind:'project_transition',
      idempotency_scope:STORAGE_SCOPE,
      idempotency_key:acquireIdempotencyKey,
      acquire_request_hash:acquireRequestHash,
    },
  };
  const intentSha256 = await sha256Text(canonicalJson(intent));
  const operationHash = await sha256Text(canonicalJson({
    schema:'project-transition-operation-id-v1',
    execution_id:`execution:${executionHash}`,
    acquire_request_hash:acquireRequestHash,
  }));
  return Object.freeze({
    execution_id:`execution:${executionHash}`,
    operation_id:uuidFromHash(operationHash),
    intent_sha256:intentSha256,
    operation_kind:'project_transition',
    idempotency_scope:STORAGE_SCOPE,
    idempotency_key:acquireIdempotencyKey,
    authority_epoch:authorityEpoch,
    lease_epoch:authorityEpoch,
  });
}

async function transitionExecutionFingerprint(revisionFingerprint, dependencyFingerprint) {
  const revision = required(revisionFingerprint, 'transition_revision_fingerprint');
  const dependency = required(dependencyFingerprint, 'transition_dependency_fingerprint');
  return sha256Text(canonicalJson({
    schema:EXECUTION_FINGERPRINT_SCHEMA,
    transition_revision_fingerprint:revision,
    transition_dependency_fingerprint:dependency,
  }));
}

function defaultCapabilityFactory() {
  return `ptl_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
}

function uniqueViolation(error) {
  return error?.code === '23505' || error?.code === 'UNIQUE_VIOLATION';
}

function operationScope(leaseId) {
  return `lease:${required(leaseId, 'leaseId')}`;
}

function canonicalInstant(value) {
  if (value === null || value === undefined || value === '') return null;
  const milliseconds = Date.parse(String(value));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : String(value);
}

function heartbeatFromOperation(row) {
  if (!row || row.state !== 'succeeded') return null;
  const resolution = object(row.resolution) || {};
  return Object.freeze({
    request_sha256:String(row.request_sha256 || ''),
    progress_sha256:String(row.result_sha256 || resolution.progress_sha256 || ''),
    previous_expires_at:canonicalInstant(resolution.previous_expires_at),
    new_expires_at:canonicalInstant(resolution.new_expires_at),
    heartbeat_count:Number(resolution.heartbeat_count || 0),
  });
}

export async function prepareProjectTransitionLeasePersistence(row, options = {}) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw Object.assign(new Error('project transition lease row must be an object'), { code:'PROJECT_TRANSITION_LEASE_PERSISTENCE_INVALID' });
  }
  const capabilityToken = required(options.capabilityToken, 'capabilityToken');
  const leaseId = required(row.lease_id, 'lease_id');
  const slotKey = required(row.slot_key, 'slot_key');
  const runId = required(row.run_id, 'run_id');
  const projectRef = required(row.project_ref, 'project_ref');
  const transitionId = required(row.transition_id, 'transition_id');
  const repository = required(row.repository, 'repository');
  const authorityRevision = required(row.authority_revision, 'authority_revision');
  const authorityDerivation = required(row.authority_derivation, 'authority_derivation');
  const graphFingerprint = required(row.graph_fingerprint, 'graph_fingerprint');
  const transitionDefinitionFingerprint = required(row.transition_definition_fingerprint, 'transition_definition_fingerprint');
  const transitionRevisionFingerprint = required(row.transition_revision_fingerprint, 'transition_revision_fingerprint');
  const transitionDependencyFingerprint = required(row.transition_dependency_fingerprint, 'transition_dependency_fingerprint');
  const acquireIdempotencyKey = required(row.acquire_idempotency_key, 'acquire_idempotency_key');
  const acquireRequestHash = required(row.acquire_request_hash, 'acquire_request_hash');

  const authorityEpoch = Math.max(1, epoch(row.authority_epoch));
  const executionIdentity = await projectTransitionExecutionIdentity({
    subjectKey:slotKey,
    projectRef,
    transitionId,
    repository,
    authorityRevision,
    graphFingerprint,
    transitionDefinitionFingerprint,
    transitionRevisionFingerprint,
    transitionDependencyFingerprint,
    acquireIdempotencyKey,
    acquireRequestHash,
    authorityEpoch,
  });
  const projectTransition = Object.freeze({
    project_ref:projectRef,
    transition_id:transitionId,
    repository,
    authority_revision:authorityRevision,
    authority_derivation:authorityDerivation,
    graph_fingerprint:graphFingerprint,
    transition_definition_fingerprint:transitionDefinitionFingerprint,
    transition_revision_fingerprint:transitionRevisionFingerprint,
    transition_dependency_fingerprint:transitionDependencyFingerprint,
    slot_key:slotKey,
    authority_epoch:authorityEpoch,
  });
  const claimReceipt = Object.freeze({
    schema:'project-transition-lease-claim-v1',
    subject:'project_transition',
    project_transition:projectTransition,
    execution_fingerprint:graphFingerprint,
    execution_id:executionIdentity.execution_id,
    operation_id:executionIdentity.operation_id,
    intent_sha256:executionIdentity.intent_sha256,
  });
  const claimRequest = Object.freeze({
    schema:'project-transition-lease-acquire-v1',
    subject:'project_transition',
    run_id:runId,
    project_ref:projectRef,
    transition_id:transitionId,
    authority_revision:authorityRevision,
    acquire_request_hash:acquireRequestHash,
  });

  return Object.freeze({
    lease_id:leaseId,
    work_ref:slotKey,
    gate:STORAGE_SCOPE,
    run_id:runId,
    lease_token:capabilityToken,
    token_hash:await sha256Text(capabilityToken),
    claim_idempotency_key:`${IDEMPOTENCY_PREFIX}${acquireIdempotencyKey}`,
    claim_request_hash:acquireRequestHash,
    acquire_request_hash:acquireRequestHash,
    claim_request:claimRequest,
    status:row.status || 'active',
    created_at:required(row.created_at, 'created_at'),
    expires_at:required(row.expires_at, 'expires_at'),
    hard_expires_at:required(row.hard_expires_at, 'hard_expires_at'),
    previous_state:'PROJECT_TRANSITION',
    previous_state_id:'project_transition',
    previous_lane:STORAGE_SCOPE,
    previous_lane_id:'project_transition',
    authority_derivation:authorityDerivation,
    claim_revision:authorityRevision,
    active_revision:authorityRevision,
    claim_receipt:claimReceipt,
    execution_id:executionIdentity.execution_id,
    operation_id:executionIdentity.operation_id,
    intent_sha256:executionIdentity.intent_sha256,
    operation_kind:executionIdentity.operation_kind,
    idempotency_scope:executionIdentity.idempotency_scope,
    idempotency_key:executionIdentity.idempotency_key,
    authority_epoch:executionIdentity.authority_epoch,
    lease_epoch:executionIdentity.lease_epoch,
  });
}

export function restoreProjectTransitionLease(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const claimReceipt = object(row.claim_receipt);
  if (claimReceipt?.subject !== 'project_transition') return null;
  const subject = object(claimReceipt.project_transition);
  if (!subject) return null;
  const claimKey = String(row.claim_idempotency_key || '');
  if (!claimKey.startsWith(IDEMPOTENCY_PREFIX)) return null;
  const settlePlan = object(row.settle_plan);
  const settleReceipt = object(row.settle_receipt);
  const settleKey = String(row.settle_idempotency_key || '');
  return Object.freeze({
    lease_id:String(row.lease_id || ''),
    subject:'project_transition',
    run_id:String(row.run_id || ''),
    project_ref:String(subject.project_ref || ''),
    transition_id:String(subject.transition_id || ''),
    repository:String(subject.repository || ''),
    authority_revision:String(subject.authority_revision || ''),
    authority_derivation:String(subject.authority_derivation || ''),
    authority_epoch:epoch(subject.authority_epoch),
    graph_fingerprint:String(subject.graph_fingerprint || ''),
    transition_definition_fingerprint:String(subject.transition_definition_fingerprint || ''),
    transition_revision_fingerprint:String(subject.transition_revision_fingerprint || ''),
    transition_dependency_fingerprint:String(subject.transition_dependency_fingerprint || ''),
    slot_key:String(subject.slot_key || row.work_ref || ''),
    status:String(row.status || ''),
    created_at:row.created_at,
    expires_at:row.expires_at,
    hard_expires_at:row.hard_expires_at,
    acquire_idempotency_key:claimKey.slice(IDEMPOTENCY_PREFIX.length),
    acquire_request_hash:String(row.claim_request_hash || ''),
    settle_idempotency_key:settleKey.startsWith(SETTLE_IDEMPOTENCY_PREFIX) ? settleKey.slice(SETTLE_IDEMPOTENCY_PREFIX.length) : (row.settle_idempotency_key || null),
    disposition:settlePlan?.disposition || null,
    settlement_evidence:Array.isArray(settlePlan?.evidence) ? settlePlan.evidence : [],
    settlement_reason:settlePlan?.reason || null,
    settlement_promotion_condition:settlePlan?.promotion_condition || null,
    settled_at:row.settled_at || null,
    graph_revision_change:settleReceipt?.graph_revision_change || null,
    settlement_receipt:object(row.settlement_receipt) || object(settleReceipt?.canonical_receipt),
    execution_id:String(row.execution_id || claimReceipt.execution_id || ''),
    operation_id:String(row.operation_id || claimReceipt.operation_id || ''),
    intent_sha256:String(row.intent_sha256 || claimReceipt.intent_sha256 || ''),
  });
}

function restoreCanonicalProjectTransitionLease(row) {
  if (!row || String(row.subject_kind || '') !== 'project_transition' || !row.lease_id) return null;
  const settlementReceipt = object(row.settlement_receipt);
  const operationCreatedAt = row.operation_created_at || row.updated_at || null;
  const lifecycle = String(row.lifecycle || '');
  const status = lifecycle === 'executing'
    ? 'active'
    : lifecycle === 'settled'
      ? 'settled'
      : lifecycle === 'rejected'
        ? 'rejected'
        : lifecycle === 'effect_uncertain'
          ? 'uncertain'
          : lifecycle;
  const authorityEpoch = epoch(row.authority_epoch);
  const subjectKey = String(row.subject_key || '');
  const leaseId = String(row.lease_id || row.lease_ref || '');
  const acquisitionKey = String(row.idempotency_key || '');
  const claimReceipt = {
    schema:'project-transition-lease-claim-v1',
    subject:'project_transition',
    project_transition:{
      project_ref:String(row.project_ref || ''),
      transition_id:String(row.transition_id || ''),
      repository:String(row.authority_repository || ''),
      authority_revision:String(row.authority_revision || '').toLowerCase(),
      authority_derivation:String(row.authority_derivation || ''),
      graph_fingerprint:String(row.graph_fingerprint || ''),
      transition_definition_fingerprint:String(row.transition_definition_fingerprint || ''),
      transition_revision_fingerprint:String(row.transition_revision_fingerprint || ''),
      transition_dependency_fingerprint:String(row.transition_dependency_fingerprint || ''),
      slot_key:subjectKey,
      authority_epoch:authorityEpoch,
    },
    execution_id:String(row.execution_id || ''),
    operation_id:String(row.operation_id || ''),
    intent_sha256:String(row.intent_sha256 || ''),
  };
  return Object.freeze({
    lease_id:leaseId,
    work_ref:subjectKey,
    gate:STORAGE_SCOPE,
    subject:'project_transition',
    run_id:String(row.run_id || ''),
    status,
    created_at:operationCreatedAt,
    expires_at:row.expires_at || null,
    hard_expires_at:row.hard_expires_at || null,
    claim_idempotency_key:acquisitionKey ? `${IDEMPOTENCY_PREFIX}${acquisitionKey}` : null,
    acquire_idempotency_key:acquisitionKey,
    claim_request_hash:String(row.acquire_request_hash || row.intent_sha256 || ''),
    claim_receipt:claimReceipt,
    authority_epoch:authorityEpoch,
    project_ref:String(row.project_ref || ''),
    transition_id:String(row.transition_id || ''),
    repository:String(row.authority_repository || ''),
    authority_revision:String(row.authority_revision || '').toLowerCase(),
    authority_derivation:String(row.authority_derivation || ''),
    graph_fingerprint:String(row.graph_fingerprint || ''),
    transition_definition_fingerprint:String(row.transition_definition_fingerprint || ''),
    transition_revision_fingerprint:String(row.transition_revision_fingerprint || ''),
    transition_dependency_fingerprint:String(row.transition_dependency_fingerprint || ''),
    slot_key:subjectKey,
    execution_id:String(row.execution_id || ''),
    operation_id:String(row.operation_id || ''),
    intent_sha256:String(row.intent_sha256 || ''),
    settle_idempotency_key:settlementReceipt?.settlement_idempotency_key || null,
    disposition:settlementReceipt?.project_transition_disposition || null,
    settlement_evidence:Array.isArray(settlementReceipt?.settlement_plan?.evidence) ? settlementReceipt.settlement_plan.evidence : [],
    settlement_reason:settlementReceipt?.settlement_plan?.reason || null,
    settlement_promotion_condition:settlementReceipt?.settlement_plan?.promotion_condition || null,
    settled_at:row.settled_at || null,
    graph_revision_change:settlementReceipt?.graph_revision_change || null,
    settlement_receipt:settlementReceipt,
  });
}
export async function reconcileExpiredLeaseItem(item, options = {}) {
  if (String(item?.subject || '') === 'project_transition') {
    if (!options.projectTransitions || typeof options.projectTransitions.reconcileExpired !== 'function') {
      throw Object.assign(new Error('project transition expiry recovery is unavailable'), { code:'PROJECT_TRANSITION_LEASE_RECOVERY_UNAVAILABLE' });
    }
    return options.projectTransitions.reconcileExpired(item.work_ref, item.lease_id, options.observedAt);
  }
  if (!options.workLeases || typeof options.workLeases.reconcileExpired !== 'function') {
    throw new TypeError('workLeases.reconcileExpired is required');
  }
  return options.workLeases.reconcileExpired(item.work_ref, item.gate);
}

export function createProjectTransitionLeasePostgresStore(dbBinding, options = {}) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('dbBinding is required');
  const capabilityFactory = options.capabilityFactory || defaultCapabilityFactory;
  async function one(sql, params = []) {
    const result = await dbBinding.query(sql, params);
    return result?.rows?.[0] || null;
  }
  async function many(sql, params = []) {
    const result = await dbBinding.query(sql, params);
    return Array.isArray(result?.rows) ? result.rows : [];
  }
  async function subjectLease(sql, params) {
    const row = await one(sql, params);
    return restoreCanonicalProjectTransitionLease(row) || restoreProjectTransitionLease(row);
  }
  async function operationByIdempotency(command, leaseId, key) {
    return one(
      `SELECT * FROM operation_state
        WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3
        LIMIT 1`,
      [command, operationScope(leaseId), key],
    );
  }
  return Object.freeze({
    async getLease(leaseId) {
      return subjectLease(
        `SELECT e.lease_ref::text AS lease_id,
                e.subject_key, e.subject_kind, e.execution_id, e.operation_id,
                e.project_ref, e.transition_id, e.run_id, e.lifecycle, e.settled,
                e.authority_epoch, e.authority_repository, e.authority_revision,
                e.authority_derivation, e.graph_fingerprint,
                e.transition_definition_fingerprint, e.transition_revision_fingerprint,
                e.transition_dependency_fingerprint, e.expires_at, e.hard_expires_at,
                e.settlement_receipt, e.settled_at, e.intent_sha256, e.acquire_request_hash,
                e.idempotency_key, o.request_sha256 AS operation_request_sha256,
                o.created_at AS operation_created_at
           FROM execution_state e
           LEFT JOIN operation_state o
             ON o.operation_id=e.operation_id AND o.execution_id=e.execution_id
          WHERE e.lease_ref=$1 AND e.subject_kind='project_transition'
          LIMIT 1`,
        [leaseId],
      );
    },
    async getLeaseByAcquireIdempotency(idempotencyKey) {
      return subjectLease(
        `SELECT e.lease_ref::text AS lease_id,
                e.subject_key, e.subject_kind, e.execution_id, e.operation_id,
                e.project_ref, e.transition_id, e.run_id, e.lifecycle, e.settled,
                e.authority_epoch, e.authority_repository, e.authority_revision,
                e.authority_derivation, e.graph_fingerprint,
                e.transition_definition_fingerprint, e.transition_revision_fingerprint,
                e.transition_dependency_fingerprint, e.expires_at, e.hard_expires_at,
                e.settlement_receipt, e.settled_at, e.intent_sha256, e.acquire_request_hash,
                e.idempotency_key, o.request_sha256 AS operation_request_sha256,
                o.created_at AS operation_created_at
           FROM execution_state e
           LEFT JOIN operation_state o
             ON o.operation_id=e.operation_id AND o.execution_id=e.execution_id
          WHERE e.subject_kind='project_transition'
            AND e.idempotency_scope=$1 AND e.idempotency_key=$2
          LIMIT 1`,
        [STORAGE_SCOPE, required(idempotencyKey, 'idempotencyKey')],
      );
    },
    async getLatestSettledLeaseForTransition(projectRef, transitionId, observedAt = null) {
      const params = [required(projectRef, 'projectRef'), required(transitionId, 'transitionId')];
      const timeClause = observedAt ? ' AND e.settled_at <= $3' : '';
      if (observedAt) params.push(required(observedAt, 'observedAt'));
      return subjectLease(
        `SELECT e.lease_ref::text AS lease_id,
                e.subject_key, e.subject_kind, e.execution_id, e.operation_id,
                e.project_ref, e.transition_id, e.run_id, e.lifecycle, e.settled,
                e.authority_epoch, e.authority_repository, e.authority_revision,
                e.authority_derivation, e.graph_fingerprint,
                e.transition_definition_fingerprint, e.transition_revision_fingerprint,
                e.transition_dependency_fingerprint, e.expires_at, e.hard_expires_at,
                e.settlement_receipt, e.settled_at, e.intent_sha256, e.acquire_request_hash,
                e.idempotency_key, o.request_sha256 AS operation_request_sha256,
                o.created_at AS operation_created_at
           FROM execution_state e
           LEFT JOIN operation_state o
             ON o.operation_id=e.operation_id AND o.execution_id=e.execution_id
          WHERE e.subject_kind='project_transition'
            AND e.project_ref=$1 AND e.transition_id=$2
            AND e.lifecycle='settled' AND e.settled=true${timeClause}
          ORDER BY e.settled_at DESC NULLS LAST, e.updated_at DESC
          LIMIT 1`,
        params,
      );
    },
    async getActiveLeasesForProject(projectRef, observedAt) {
      const rows = await many(
        `SELECT e.lease_ref::text AS lease_id,
                e.subject_key, e.subject_kind, e.execution_id, e.operation_id,
                e.project_ref, e.transition_id, e.run_id, e.lifecycle, e.settled,
                e.authority_epoch, e.authority_repository, e.authority_revision,
                e.authority_derivation, e.graph_fingerprint,
                e.transition_definition_fingerprint, e.transition_revision_fingerprint,
                e.transition_dependency_fingerprint, e.expires_at, e.hard_expires_at,
                e.settlement_receipt, e.settled_at, e.intent_sha256, e.acquire_request_hash,
                e.idempotency_key, o.request_sha256 AS operation_request_sha256,
                o.created_at AS operation_created_at
           FROM execution_state e
           LEFT JOIN operation_state o
             ON o.operation_id=e.operation_id AND o.execution_id=e.execution_id
          WHERE e.subject_kind='project_transition'
            AND e.project_ref=$1 AND e.lifecycle='executing' AND e.settled=false
            AND e.lease_ref IS NOT NULL AND e.expires_at > $2
          ORDER BY e.updated_at ASC, e.lease_ref ASC`,
        [required(projectRef, 'projectRef'), required(observedAt, 'observedAt')],
      );
      return rows.map(restoreCanonicalProjectTransitionLease).filter(Boolean);
    },
    async getActiveLeasesForTransition(projectRef, transitionId, observedAt, authorityRevision = null) {
      const params = [required(projectRef, 'projectRef'), required(transitionId, 'transitionId'), required(observedAt, 'observedAt')];
      const revisionClause = authorityRevision ? ' AND e.authority_revision=$4' : '';
      if (authorityRevision) params.push(required(authorityRevision, 'authorityRevision'));
      const rows = await many(
        `SELECT e.lease_ref::text AS lease_id,
                e.subject_key, e.subject_kind, e.execution_id, e.operation_id,
                e.project_ref, e.transition_id, e.run_id, e.lifecycle, e.settled,
                e.authority_epoch, e.authority_repository, e.authority_revision,
                e.authority_derivation, e.graph_fingerprint,
                e.transition_definition_fingerprint, e.transition_revision_fingerprint,
                e.transition_dependency_fingerprint, e.expires_at, e.hard_expires_at,
                e.settlement_receipt, e.settled_at, e.intent_sha256, e.acquire_request_hash,
                e.idempotency_key, o.request_sha256 AS operation_request_sha256,
                o.created_at AS operation_created_at
           FROM execution_state e
           LEFT JOIN operation_state o
             ON o.operation_id=e.operation_id AND o.execution_id=e.execution_id
          WHERE e.subject_kind='project_transition'
            AND e.project_ref=$1 AND e.transition_id=$2
            AND e.lifecycle='executing' AND e.settled=false
            AND e.lease_ref IS NOT NULL AND e.expires_at > $3${revisionClause}
          ORDER BY e.updated_at ASC, e.lease_ref ASC
          LIMIT 8`,
        params,
      );
      return rows.map(restoreCanonicalProjectTransitionLease).filter(Boolean);
    },
    async getSlot(slotKey) {
      return one(
        `SELECT e.subject_key AS slot_key, e.lease_ref::text AS lease_id, e.expires_at
           FROM execution_state e
          WHERE e.subject_key=$1 AND e.subject_kind='project_transition'
            AND e.lifecycle='executing' AND e.settled=false AND e.lease_ref IS NOT NULL
          LIMIT 1`,
        [required(slotKey, 'slotKey')],
      );
    },
    async getExecutionState(subjectKey) {
      const row = await one('SELECT * FROM execution_state WHERE subject_key=$1 LIMIT 1', [required(subjectKey, 'subjectKey')]);
      if (!row) return null;
      return Object.freeze({
        ...row,
        authority_epoch:epoch(row.authority_epoch),
        lease_ref:row.lease_ref == null ? null : String(row.lease_ref),
        run_id:row.run_id == null ? null : String(row.run_id),
      });
    },
    async getRun(runId) {
      return one('SELECT run_id,status,deadline_at,settlement_reserve_seconds FROM orchestration_runs WHERE run_id=$1 LIMIT 1', [runId]);
    },
    async getCheckpointByIdempotency(leaseId, key) {
      const row = await operationByIdempotency(CHECKPOINT_OPERATION, leaseId, key);
      if (!row || row.state !== 'succeeded') return null;
      return Object.freeze({
        request_sha256:String(row.request_sha256 || ''),
        checkpoint_sha256:String(row.result_sha256 || ''),
      });
    },
    async getLatestCheckpoint(leaseId) {
      const row = await one(
        `SELECT checkpoint,checkpoint_sha256
           FROM execution_state
          WHERE lease_ref=$1
          LIMIT 1`,
        [leaseId],
      );
      if (!row?.checkpoint_sha256) return null;
      return Object.freeze({ checkpoint:row.checkpoint, checkpoint_sha256:String(row.checkpoint_sha256) });
    },
    async getHeartbeatByIdempotency(leaseId, key) {
      return heartbeatFromOperation(await operationByIdempotency(HEARTBEAT_OPERATION, leaseId, key));
    },
    async listRecentHeartbeats(leaseId, limit = 2) {
      const row = await one(
        `SELECT recent_progress_sha256
           FROM execution_state
          WHERE lease_ref=$1
          LIMIT 1`,
        [leaseId],
      );
      const values = Array.isArray(row?.recent_progress_sha256) ? row.recent_progress_sha256.map(String) : [];
      return values.slice(-Math.min(2, Math.max(1, Number(limit) || 2))).map((progressSha) => Object.freeze({ progress_sha256:progressSha }));
    },
    async insertCheckpoint(leaseId, idem, requestHash, checkpoint, checkpointSha, createdAt, operationCommand = CHECKPOINT_OPERATION) {
      if (typeof dbBinding.transaction !== 'function') {
        throw Object.assign(new Error('project transition checkpoint persistence requires transactional storage'), { code:'PROJECT_TRANSITION_CHECKPOINT_STORAGE_UNAVAILABLE' });
      }
      const operationId = crypto.randomUUID();
      const scope = operationScope(leaseId);
      const tx = await dbBinding.transaction([
        {
          sql:`INSERT INTO operation_state (
                 operation_id,command,idempotency_scope,idempotency_key,request_sha256,state,
                 execution_id,subject_key,run_id,lease_epoch,authority_epoch,
                 authority_repository,authority_revision,attempt_epoch,may_have_mutated,
                 mutation_certainty,effect_kind,created_at
               )
               SELECT $1,$2,$3,$4,$5,'prepared',
                      execution_id,subject_key,run_id,lease_epoch,authority_epoch,
                      authority_repository,authority_revision,current_attempt_epoch,false,
                      'definitely_not_mutated','execution_checkpoint',$6
                 FROM execution_state
                WHERE lease_ref=$7
                  AND lifecycle='executing'
               ON CONFLICT (command,idempotency_scope,idempotency_key) DO NOTHING
               RETURNING operation_id`,
          params:[operationId, operationCommand, scope, idem, requestHash, createdAt, leaseId],
        },
        {
          sql:`UPDATE execution_state
                  SET checkpoint=$2::jsonb,checkpoint_sha256=$3,updated_at=$4
                WHERE lease_ref=$1
                  AND lifecycle='executing'
                  AND EXISTS (
                    SELECT 1
                      FROM operation_state operation
                     WHERE operation.operation_id=$5
                       AND operation.execution_id=execution_state.execution_id
                       AND operation.state='prepared'
                  )
                RETURNING subject_key`,
          params:[leaseId, JSON.stringify(checkpoint), checkpointSha, createdAt, operationId],
        },
        {
          sql:`UPDATE operation_state
                  SET state='succeeded',may_have_mutated=false,
                      mutation_certainty='definitely_not_mutated',
                      effect_kind='execution_checkpoint',effect_ref=$2,
                      result_sha256=$3,recovery_payload=NULL,
                      resolution=jsonb_build_object('checkpoint_sha256',$3::text),resolved_at=$4
                WHERE operation_id=$1
                  AND EXISTS (
                    SELECT 1
                      FROM execution_state
                     WHERE lease_ref=$5
                       AND checkpoint_sha256=$3
                       AND execution_state.execution_id=operation_state.execution_id
                  )
                RETURNING request_sha256,result_sha256 AS checkpoint_sha256`,
          params:[operationId, `lease:${leaseId}`, checkpointSha, createdAt, leaseId],
        },
        {
          sql:`SELECT 1 / CASE WHEN
                  NOT EXISTS (SELECT 1 FROM operation_state WHERE operation_id=$1)
                  OR EXISTS (SELECT 1 FROM operation_state WHERE operation_id=$1 AND state='succeeded' AND result_sha256=$2)
                THEN 1 ELSE 0 END AS atomicity_guard`,
          params:[operationId, checkpointSha],
        },
      ]);
      const saved = tx?.results?.[2]?.rows?.[0] || null;
      if (saved) return Object.freeze(saved);
      const existing = await operationByIdempotency(operationCommand, leaseId, idem);
      if (existing) {
        if (String(existing.request_sha256 || '') !== requestHash) {
          throw Object.assign(new Error('project transition checkpoint idempotency conflict'), { code:'PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT' });
        }
        if (existing.state === 'succeeded') {
          return Object.freeze({ request_sha256:String(existing.request_sha256), checkpoint_sha256:String(existing.result_sha256 || '') });
        }
      }
      throw Object.assign(new Error('project transition checkpoint used stale canonical execution authority'), { code:'PROJECT_TRANSITION_LEASE_STALE' });
    },
    async acquireLeaseAtomically(row) {
      const persisted = await prepareProjectTransitionLeasePersistence(row, { capabilityToken:capabilityFactory() });
      const subjectKey = required(row.slot_key, 'slot_key');
      const projectRef = required(row.project_ref, 'project_ref');
      const transitionId = required(row.transition_id, 'transition_id');
      const repository = required(row.repository, 'repository');
      const authorityRevision = required(row.authority_revision, 'authority_revision');
      const graphFingerprint = required(row.graph_fingerprint, 'graph_fingerprint');
      const transitionRevisionFingerprint = required(row.transition_revision_fingerprint, 'transition_revision_fingerprint');
      const transitionDependencyFingerprint = required(row.transition_dependency_fingerprint, 'transition_dependency_fingerprint');
      const params = [
        subjectKey,
        projectRef,
        transitionId,
        persisted.created_at,
        persisted.lease_id,
        persisted.run_id,
        repository,
        authorityRevision,
        graphFingerprint,
        transitionRevisionFingerprint,
        transitionDependencyFingerprint,
        persisted.expires_at,
        persisted.hard_expires_at,
        persisted.lease_token,
        persisted.work_ref,
        persisted.gate,
        persisted.token_hash,
        persisted.claim_idempotency_key,
        persisted.claim_request_hash,
        persisted.status,
        persisted.previous_state,
        persisted.previous_state_id,
        persisted.previous_lane,
        persisted.previous_lane_id,
        persisted.claim_revision,
        persisted.active_revision,
        JSON.stringify(persisted.claim_receipt),
        JSON.stringify(persisted.claim_request),
      ];
      if (typeof dbBinding.transaction !== 'function') {
        throw Object.assign(new Error('project transition acquisition requires transactional storage'), { code:'PROJECT_TRANSITION_LEASE_STORAGE_UNAVAILABLE' });
      }
      try {
        const tx = await dbBinding.transaction([
          {
            sql:`INSERT INTO execution_state (
               execution_id,subject_key,subject_kind,project_ref,transition_id,operation_id,
               lifecycle,lease_epoch,lease_ref,run_id,authority_epoch,
               authority_repository,authority_revision,authority_derivation,graph_fingerprint,transition_revision_fingerprint,
               transition_dependency_fingerprint,expires_at,hard_expires_at,active_capability_material,
               checkpoint,checkpoint_sha256,recent_progress_sha256,heartbeat_count,last_heartbeat_at,
               current_attempt_epoch,mutation_certainty,effect_ref,operation_kind,idempotency_scope,
               idempotency_key,intent_sha256,acquire_request_hash,settled,settlement_receipt,settled_at,updated_at
             ) VALUES (
               $29,$1,'project_transition',$2,$3,$30,'executing',$35,$5,$6,$35,
               $7,$8,$36,$9,$10,$11,$12,$13,$14,NULL,NULL,'[]'::jsonb,0,NULL,
               0,'definitely_not_mutated',NULL,$32,$33,$34,$31,$37,false,NULL,NULL,$4
             )
             ON CONFLICT (subject_key) DO UPDATE SET
               execution_id=execution_state.execution_id,
               project_ref=EXCLUDED.project_ref,
               transition_id=EXCLUDED.transition_id,
               operation_id=EXCLUDED.operation_id,
               lifecycle='executing',
               lease_epoch=execution_state.lease_epoch+1,
               authority_epoch=execution_state.authority_epoch+1,
               lease_ref=EXCLUDED.lease_ref,
               run_id=EXCLUDED.run_id,
               authority_repository=EXCLUDED.authority_repository,
               authority_revision=EXCLUDED.authority_revision,
               authority_derivation=EXCLUDED.authority_derivation,
               graph_fingerprint=EXCLUDED.graph_fingerprint,
               transition_revision_fingerprint=EXCLUDED.transition_revision_fingerprint,
               transition_dependency_fingerprint=EXCLUDED.transition_dependency_fingerprint,
               expires_at=EXCLUDED.expires_at,
               hard_expires_at=EXCLUDED.hard_expires_at,
               active_capability_material=EXCLUDED.active_capability_material,
               operation_kind=EXCLUDED.operation_kind,
               idempotency_scope=EXCLUDED.idempotency_scope,
               idempotency_key=EXCLUDED.idempotency_key,
               intent_sha256=EXCLUDED.intent_sha256,
               acquire_request_hash=EXCLUDED.acquire_request_hash,
               current_attempt_epoch=0,
               mutation_certainty='definitely_not_mutated',
               effect_ref=NULL,
               settled=false,
               settlement_receipt=NULL,
               settled_at=NULL,
               checkpoint=NULL,
               checkpoint_sha256=NULL,
               recent_progress_sha256='[]'::jsonb,
               heartbeat_count=0,
               last_heartbeat_at=NULL,
               updated_at=EXCLUDED.updated_at
             WHERE execution_state.subject_kind='project_transition'
               AND (
                 execution_state.lease_ref IS NULL
                 OR execution_state.lifecycle IN ('settled','rejected','escalated','effect_absent')
               )
             RETURNING authority_epoch,lease_epoch,execution_id,operation_id`,
            params:[
              ...params,
              persisted.execution_id,
              persisted.operation_id,
              persisted.intent_sha256,
              persisted.operation_kind,
              persisted.idempotency_scope,
              persisted.idempotency_key,
              persisted.lease_epoch,
              persisted.authority_derivation,
              persisted.acquire_request_hash,
            ],
          },
          {
            sql:`INSERT INTO operation_state (
               operation_id,command,idempotency_scope,idempotency_key,request_sha256,state,
               execution_id,subject_key,run_id,lease_epoch,authority_epoch,
               authority_repository,authority_revision,attempt_epoch,may_have_mutated,
               mutation_certainty,effect_kind
             )
             SELECT $21,'execution.transaction',$23,$24,$22,'prepared',
                    execution_id,subject_key,run_id,lease_epoch,authority_epoch,
                    authority_repository,authority_revision,0,false,
                    'definitely_not_mutated',$25
               FROM execution_state
              WHERE subject_key=$1 AND lease_ref=$2 AND run_id=$3
             ON CONFLICT (command,idempotency_scope,idempotency_key) DO NOTHING
             RETURNING operation_id
           `,
            params:[
              subjectKey,
              persisted.lease_id,
              persisted.run_id,
              persisted.lease_token,
              persisted.work_ref,
              persisted.gate,
              persisted.token_hash,
              persisted.claim_idempotency_key,
              persisted.claim_request_hash,
              persisted.status,
              persisted.created_at,
              persisted.expires_at,
              persisted.previous_state,
              persisted.previous_state_id,
              persisted.previous_lane,
              persisted.previous_lane_id,
              persisted.claim_revision,
              persisted.active_revision,
              JSON.stringify(persisted.claim_receipt),
              JSON.stringify(persisted.claim_request),
              persisted.operation_id,
              persisted.intent_sha256,
              persisted.idempotency_scope,
              persisted.idempotency_key,
              persisted.operation_kind,
              persisted.hard_expires_at,
            ],
          },
          {
            sql:`INSERT INTO work_leases (
               lease_id,work_ref,gate,run_id,lease_token,token_hash,claim_idempotency_key,claim_request_hash,
               status,created_at,expires_at,previous_state,previous_state_id,previous_lane,previous_lane_id,
               claim_revision,active_revision,claim_receipt,claim_request,hard_expires_at
             )
             SELECT $2,$5,$6,$3,$4,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                    jsonb_set($19::jsonb,'{project_transition,authority_epoch}',to_jsonb(execution_state.authority_epoch),true),
                    $20::jsonb,$21
               FROM execution_state
              WHERE subject_key=$1 AND lease_ref=$2 AND run_id=$3
                AND operation_id=$22
             RETURNING *`,
            params:[
              subjectKey,
              persisted.lease_id,
              persisted.run_id,
              persisted.lease_token,
              persisted.work_ref,
              persisted.gate,
              persisted.token_hash,
              persisted.claim_idempotency_key,
              persisted.claim_request_hash,
              persisted.status,
              persisted.created_at,
              persisted.expires_at,
              persisted.previous_state,
              persisted.previous_state_id,
              persisted.previous_lane,
              persisted.previous_lane_id,
              persisted.claim_revision,
              persisted.active_revision,
              JSON.stringify(persisted.claim_receipt),
              JSON.stringify(persisted.claim_request),
              persisted.hard_expires_at,
              persisted.operation_id,
            ],
          },
          {
            sql:`INSERT INTO work_lease_slots (work_ref,gate,lease_id,expires_at)
                 SELECT $1,$2,$3,$4
                   FROM work_leases
                  WHERE lease_id=$3 AND claim_receipt->>'subject'='project_transition'
                 RETURNING lease_id`,
            params:[persisted.work_ref,persisted.gate,persisted.lease_id,persisted.expires_at],
          },
          {
            sql:`SELECT 1 / CASE WHEN
                   EXISTS (SELECT 1 FROM execution_state WHERE subject_key=$1 AND lease_ref=$2 AND run_id=$3 AND operation_id=$4 AND lifecycle='executing')
                   AND EXISTS (SELECT 1 FROM operation_state WHERE operation_id=$4 AND execution_id=(SELECT execution_id FROM execution_state WHERE subject_key=$1))
                   AND EXISTS (SELECT 1 FROM work_lease_slots WHERE work_ref=$1 AND gate='project_transition' AND lease_id=$2)
                 THEN 1 ELSE 0 END AS atomicity_guard`,
            params:[subjectKey,persisted.lease_id,persisted.run_id,persisted.operation_id],
          },
        ]);
        const inserted = tx?.results?.[2]?.rows?.[0] || null;
        if (!inserted) {
          const conflict = new Error('project transition canonical execution authority is already occupied');
          conflict.code = 'UNIQUE_VIOLATION';
          throw conflict;
        }
        return restoreProjectTransitionLease(inserted);
      } catch (error) {
        if (uniqueViolation(error) || error?.code === '22012') {
          const conflict = new Error('project transition slot is already occupied');
          conflict.code = 'UNIQUE_VIOLATION';
          throw conflict;
        }
        throw error;
      }
    },
    async insertLease(row) {
      const persisted = await prepareProjectTransitionLeasePersistence(row, { capabilityToken:capabilityFactory() });
      const inserted = await one(
        `INSERT INTO work_leases (
           lease_id,work_ref,gate,run_id,lease_token,token_hash,claim_idempotency_key,claim_request_hash,
           status,created_at,expires_at,previous_state,previous_state_id,previous_lane,previous_lane_id,
           claim_revision,active_revision,claim_receipt,claim_request,hard_expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20)
         RETURNING *`,
        [
          persisted.lease_id,persisted.work_ref,persisted.gate,persisted.run_id,persisted.lease_token,persisted.token_hash,
          persisted.claim_idempotency_key,persisted.claim_request_hash,persisted.status,persisted.created_at,persisted.expires_at,
          persisted.previous_state,persisted.previous_state_id,persisted.previous_lane,persisted.previous_lane_id,
          persisted.claim_revision,persisted.active_revision,JSON.stringify(persisted.claim_receipt),JSON.stringify(persisted.claim_request),
          persisted.hard_expires_at,
        ],
      );
      return restoreProjectTransitionLease(inserted);
    },
    async insertSlot(row) {
      try {
        return await one(
          'INSERT INTO work_lease_slots (work_ref,gate,lease_id,expires_at) VALUES ($1,$2,$3,$4) RETURNING work_ref AS slot_key,lease_id::text AS lease_id,expires_at',
          [row.slot_key, STORAGE_SCOPE, row.lease_id, row.expires_at],
        );
      } catch (error) {
        if (uniqueViolation(error)) {
          const conflict = new Error('project transition slot is already occupied');
          conflict.code = 'UNIQUE_VIOLATION';
          throw conflict;
        }
        throw error;
      }
    },
    async updateLease(leaseId, patch = {}) {
      if (patch.status === 'rejected') {
        const updated = await one(
          `UPDATE work_leases
              SET status='rejected', reconciliation=$2::jsonb, updated_at=now()
            WHERE lease_id=$1 AND claim_receipt->>'subject' = 'project_transition'
            RETURNING *`,
          [leaseId, JSON.stringify({ schema:'project-transition-lease-rejection-v1', code:patch.rejection_code || 'PROJECT_TRANSITION_ALREADY_LEASED' })],
        );
        return restoreProjectTransitionLease(updated);
      }
      if (patch.status === 'settled') {
        const current = await one(`SELECT * FROM work_leases WHERE lease_id=$1 AND claim_receipt->>'subject' = 'project_transition' LIMIT 1`, [leaseId]);
        if (!current) return null;
        const claimReceipt = object(current.claim_receipt);
        const settledAt = required(patch.settled_at, 'settled_at');
        const disposition = required(patch.disposition, 'disposition');
        const settleKey = `${SETTLE_IDEMPOTENCY_PREFIX}${required(patch.settle_idempotency_key, 'settle_idempotency_key')}`;
        const settlePlan = settlementPlan(disposition, patch);
        const settleReceipt = {
          schema:'project-transition-lease-settlement-v1',
          subject:'project_transition',
          lease_ref:String(leaseId),
          project_transition:claimReceipt?.project_transition || null,
          disposition,
          settled_at:settledAt,
          graph_revision_change:patch.graph_revision_change || null,
        };
        const updated = await one(
          `UPDATE work_leases
              SET status='settled', settle_idempotency_key=$2, settle_plan=$3::jsonb, settle_receipt=$4::jsonb,
                  settled_at=$5, updated_at=now()
            WHERE lease_id=$1 AND claim_receipt->>'subject' = 'project_transition'
            RETURNING *`,
          [leaseId, settleKey, JSON.stringify(settlePlan), JSON.stringify(settleReceipt), settledAt],
        );
        return restoreProjectTransitionLease(updated);
      }
      throw Object.assign(new Error('unsupported project transition lease update'), { code:'PROJECT_TRANSITION_LEASE_PERSISTENCE_INVALID' });
    },
    async settleLeaseAtomically(input) {
      if (typeof dbBinding.transaction !== 'function') {
        throw Object.assign(new Error('project transition settlement persistence requires transactional storage'), { code:'PROJECT_TRANSITION_LEASE_SETTLEMENT_STORAGE_UNAVAILABLE' });
      }
      const leaseId = required(input?.lease_id, 'lease_id');
      const slotKey = required(input?.slot_key, 'slot_key');
      const runId = required(input?.run_id, 'run_id');
      const disposition = required(input?.disposition, 'disposition');
      const settledAt = required(input?.settled_at, 'settled_at');
      const settleKey = `${SETTLE_IDEMPOTENCY_PREFIX}${required(input?.settle_idempotency_key, 'settle_idempotency_key')}`;
      const authorityEpoch = epoch(input?.authority_epoch);
      const executionId = required(input?.execution_id, 'execution_id');
      const operationId = required(input?.operation_id, 'operation_id');
      const continuationExecutionFingerprint = input?.continuation_execution_fingerprint
        ? required(input.continuation_execution_fingerprint, 'continuation_execution_fingerprint')
        : await transitionExecutionFingerprint(input?.transition_revision_fingerprint, input?.transition_dependency_fingerprint);
      const projectTransition = {
        project_ref:required(input?.project_ref, 'project_ref'),
        transition_id:required(input?.transition_id, 'transition_id'),
        repository:required(input?.repository, 'repository'),
        authority_revision:required(input?.authority_revision, 'authority_revision'),
        authority_derivation:required(input?.authority_derivation, 'authority_derivation'),
        graph_fingerprint:required(input?.graph_fingerprint, 'graph_fingerprint'),
        transition_definition_fingerprint:required(input?.transition_definition_fingerprint, 'transition_definition_fingerprint'),
        transition_revision_fingerprint:required(input?.transition_revision_fingerprint, 'transition_revision_fingerprint'),
        transition_dependency_fingerprint:required(input?.transition_dependency_fingerprint, 'transition_dependency_fingerprint'),
        slot_key:slotKey,
        ...(authorityEpoch > 0 ? { authority_epoch:authorityEpoch } : {}),
      };
      const settlePlan = settlementPlan(disposition, input);
      const canonicalSettlementEvidence = {
        schema:'project-transition-settlement-evidence-v1',
        execution_id:executionId,
        operation_id:operationId,
        authority:{
          repository:projectTransition.repository,
          revision:projectTransition.authority_revision,
          epoch:authorityEpoch,
        },
        disposition,
        settlement:settlePlan,
        graph_revision_change:input?.graph_revision_change || null,
      };
      const canonicalEvidenceSha256 = await sha256Text(canonicalJson(canonicalSettlementEvidence));
      const canonicalSettlementReceipt = {
        schema:'settlement-receipt-v1',
        execution_id:executionId,
        operation_id:operationId,
        authority_revision:projectTransition.authority_revision,
        authority_epoch:authorityEpoch,
        settlement_idempotency_key:settleKey.slice(SETTLE_IDEMPOTENCY_PREFIX.length),
        lifecycle:'settled',
        disposition:disposition === 'completed' ? 'completed' : 'escalated',
        effect_ref:null,
        evidence_sha256:canonicalEvidenceSha256,
        project_transition_disposition:disposition,
        settlement_plan:settlePlan,
        project_transition:projectTransition,
        graph_revision_change:input?.graph_revision_change || null,
      };
      const settleReceipt = {
        schema:'project-transition-lease-settlement-v1',
        subject:'project_transition',
        lease_ref:leaseId,
        project_transition:projectTransition,
        disposition,
        settled_at:settledAt,
        graph_revision_change:input?.graph_revision_change || null,
        canonical_receipt:canonicalSettlementReceipt,
      };
      const tx = await dbBinding.transaction([
        {
          sql:`SELECT e.execution_id,e.operation_id
                  FROM execution_state e
                 WHERE e.subject_key=$1
                   AND e.execution_id=$2
                   AND e.operation_id=$3
                   AND e.lease_ref=$4
                   AND e.run_id=$5
                   AND e.authority_epoch=$6
                   AND e.authority_repository=$7
                   AND e.authority_revision=$8
                   AND e.authority_derivation=$9
                   AND e.project_ref=$10
                   AND e.transition_id=$11
                   AND e.graph_fingerprint=$12
                   AND e.transition_revision_fingerprint=$13
                   AND e.transition_dependency_fingerprint=$14
                   AND e.expires_at>$15
                   AND e.lifecycle='executing'
                   AND e.settled=false
                 FOR UPDATE`,
          params:[
            slotKey,
            executionId,
            operationId,
            leaseId,
            runId,
            authorityEpoch,
            projectTransition.repository,
            projectTransition.authority_revision,
            projectTransition.authority_derivation,
            projectTransition.project_ref,
            projectTransition.transition_id,
            projectTransition.graph_fingerprint,
            projectTransition.transition_revision_fingerprint,
            projectTransition.transition_dependency_fingerprint,
            settledAt,
          ],
        },
        {
          sql:`UPDATE work_leases l
                  SET status='settled', settle_idempotency_key=$4, settle_plan=$5::jsonb, settle_receipt=$6::jsonb,
                      settled_at=$7, updated_at=now()
                WHERE l.lease_id=$1 AND l.work_ref=$2 AND l.gate=$3 AND l.run_id=$8
                  AND l.claim_receipt->>'subject'='project_transition'
                  AND l.claim_receipt->'project_transition' @> $9::jsonb
                  AND l.status='active'
                  AND EXISTS (SELECT 1 FROM work_lease_slots s WHERE s.work_ref=$2 AND s.gate=$3 AND s.lease_id=l.lease_id)
                RETURNING l.*`,
          params:[
            leaseId,
            slotKey,
            STORAGE_SCOPE,
            settleKey,
            JSON.stringify(settlePlan),
            JSON.stringify(settleReceipt),
            settledAt,
            runId,
            JSON.stringify(projectTransition),
          ],
        },
        {
          sql:`DELETE FROM work_lease_slots s
                WHERE s.work_ref=$1 AND s.gate=$2 AND s.lease_id=$3
                  AND EXISTS (SELECT 1 FROM work_leases l WHERE l.lease_id=$3 AND l.status='settled' AND l.settle_idempotency_key=$4)
                RETURNING s.lease_id::text AS lease_id`,
          params:[slotKey, STORAGE_SCOPE, leaseId, settleKey],
        },
        {
          sql:`UPDATE operation_state
                  SET state='succeeded',
                      may_have_mutated=false,
                      mutation_certainty='definitely_not_mutated',
                      effect_kind='project_transition_settlement',
                      effect_ref=NULL,
                      result_sha256=$3,
                      recovery_payload=NULL,
                      resolution=$4::jsonb,
                      resolved_at=$5
                WHERE operation_id=$1
                  AND execution_id=$2
                  AND EXISTS (
                    SELECT 1
                      FROM work_leases l
                     WHERE l.lease_id=$6
                       AND l.status='settled'
                       AND l.settle_idempotency_key=$7
                  )
                RETURNING operation_id`,
          params:[
            operationId,
            executionId,
            canonicalEvidenceSha256,
            JSON.stringify(canonicalSettlementReceipt),
            settledAt,
            leaseId,
            settleKey,
          ],
        },
        {
          sql:`UPDATE execution_state
                  SET lifecycle='settled',
                      settled=true,
                      settlement_receipt=$9::jsonb,
                      settled_at=$5,
                      mutation_certainty='definitely_not_mutated',
                      effect_ref=NULL,
                      no_progress_streak=CASE
                        WHEN checkpoint_sha256 IS NULL THEN no_progress_streak
                        WHEN continuation_sha256=checkpoint_sha256 AND continuation_execution_fingerprint=$6 THEN no_progress_streak+1
                        ELSE 0
                      END,
                      continuation=CASE WHEN checkpoint_sha256 IS NULL THEN continuation ELSE checkpoint END,
                      continuation_sha256=CASE WHEN checkpoint_sha256 IS NULL THEN continuation_sha256 ELSE checkpoint_sha256 END,
                      continuation_execution_fingerprint=CASE WHEN checkpoint_sha256 IS NULL THEN continuation_execution_fingerprint ELSE $6 END,
                      active_capability_material=NULL,
                      checkpoint=NULL,
                      checkpoint_sha256=NULL,
                      recent_progress_sha256='[]'::jsonb,
                      heartbeat_count=0,
                      last_heartbeat_at=NULL,
                      updated_at=$5
                WHERE subject_key=$1
                  AND execution_id=$7
                  AND operation_id=$8
                  AND lease_ref=$2
                  AND run_id=$10
                  AND authority_epoch=$3
                  AND EXISTS (
                    SELECT 1
                      FROM work_leases l
                     WHERE l.lease_id=$2
                       AND l.status='settled'
                       AND l.settle_idempotency_key=$4
                  )
                RETURNING subject_key,execution_id,operation_id,settlement_receipt,continuation,continuation_sha256,continuation_execution_fingerprint,no_progress_streak`,
          params:[
            slotKey,
            leaseId,
            authorityEpoch,
            settleKey,
            settledAt,
            continuationExecutionFingerprint,
            executionId,
            operationId,
            JSON.stringify(canonicalSettlementReceipt),
            runId,
          ],
        },
        {
          sql:`SELECT 1 / CASE WHEN
                  EXISTS (SELECT 1 FROM work_leases l WHERE l.lease_id=$1 AND l.work_ref=$2 AND l.gate=$3 AND l.run_id=$4 AND l.status='settled' AND l.settle_idempotency_key=$5 AND l.settle_plan->>'disposition'=$6)
                  AND NOT EXISTS (SELECT 1 FROM work_lease_slots s WHERE s.work_ref=$2 AND s.gate=$3 AND s.lease_id=$1)
                  AND EXISTS (
                    SELECT 1
                      FROM execution_state e
                     WHERE e.subject_key=$2
                       AND e.execution_id=$8
                       AND e.operation_id=$9
                       AND e.authority_epoch=$7
                       AND e.lifecycle='settled'
                       AND e.settled=true
                       AND e.settlement_receipt->>'evidence_sha256'=$10
                  )
                  AND EXISTS (
                    SELECT 1
                      FROM operation_state o
                     WHERE o.operation_id=$9
                       AND o.execution_id=$8
                       AND o.state='succeeded'
                       AND o.mutation_certainty='definitely_not_mutated'
                  )
                THEN 1 ELSE 0 END AS atomicity_guard`,
          params:[leaseId, slotKey, STORAGE_SCOPE, runId, settleKey, disposition, authorityEpoch, executionId, operationId, canonicalEvidenceSha256],
        },
      ]);
      const updated = tx?.results?.[1]?.rows?.[0] || null;
      const atomicityGuard = tx?.results?.[5]?.rows?.[0]?.atomicity_guard;
      if (updated && Number(atomicityGuard) === 1) return restoreProjectTransitionLease(updated);
      const existing = await this.getLease(leaseId);
      if (existing?.status === 'settled' && existing.settle_idempotency_key === required(input?.settle_idempotency_key, 'settle_idempotency_key') && existing.disposition === disposition) {
        return existing;
      }
      throw Object.assign(new Error('project transition lease and slot could not be atomically settled'), { code:'PROJECT_TRANSITION_LEASE_STALE' });
    },
    async extendLeaseWithHeartbeat(input) {
      if (typeof dbBinding.transaction !== 'function') {
        throw Object.assign(new Error('project transition heartbeat persistence requires transactional storage'), { code:'PROJECT_TRANSITION_HEARTBEAT_STORAGE_UNAVAILABLE' });
      }
      const leaseId = required(input?.lease_id, 'lease_id');
      const slotKey = required(input?.slot_key, 'slot_key');
      const authorityEpoch = optionalEpoch(input?.authority_epoch);
      const idem = required(input?.idempotency_key, 'idempotency_key');
      const requestHash = required(input?.request_sha256, 'request_sha256');
      const progressSha = required(input?.progress_sha256, 'progress_sha256');
      const previousExpiresAt = required(input?.previous_expires_at, 'previous_expires_at');
      const newExpiresAt = required(input?.new_expires_at, 'new_expires_at');
      const createdAt = required(input?.created_at, 'created_at');
      const operationId = crypto.randomUUID();
      const scope = operationScope(leaseId);
      const tx = await dbBinding.transaction([
        {
          sql:`SELECT l.lease_id
                 FROM work_leases l
                 JOIN work_lease_slots s ON s.lease_id=l.lease_id AND s.work_ref=$2 AND s.gate=$3
                 JOIN execution_state e ON e.lease_ref=l.lease_id AND e.subject_key=$2 AND ($4::bigint IS NULL OR e.authority_epoch=$4)
                WHERE l.lease_id=$1
                  AND l.claim_receipt->>'subject'='project_transition'
                  AND l.status='active'
                  AND l.expires_at>$5
                  AND s.expires_at>$5
                FOR UPDATE OF l,s,e`,
          params:[leaseId, slotKey, STORAGE_SCOPE, authorityEpoch, createdAt],
        },
        {
          sql:`INSERT INTO operation_state (
                 operation_id,command,idempotency_scope,idempotency_key,request_sha256,state,
                 execution_id,subject_key,run_id,lease_epoch,authority_epoch,
                 authority_repository,authority_revision,attempt_epoch,may_have_mutated,
                 mutation_certainty,effect_kind,created_at
               )
               SELECT $1,$2,$3,$4,$5,'prepared',
                      e.execution_id,e.subject_key,e.run_id,e.lease_epoch,e.authority_epoch,
                      e.authority_repository,e.authority_revision,e.current_attempt_epoch,false,
                      'definitely_not_mutated','execution_heartbeat',$6
                 FROM execution_state e
                 JOIN work_leases l ON l.lease_id=e.lease_ref
                 JOIN work_lease_slots s ON s.lease_id=l.lease_id AND s.work_ref=e.subject_key AND s.gate=$10
                WHERE e.subject_key=$7 AND e.lease_ref=$8 AND ($9::bigint IS NULL OR e.authority_epoch=$9)
                  AND e.lifecycle='executing'
                  AND l.claim_receipt->>'subject'='project_transition'
                  AND l.status='active'
                  AND l.expires_at>$6
                  AND s.expires_at>$6
               ON CONFLICT (command,idempotency_scope,idempotency_key) DO NOTHING
               RETURNING operation_id`,
          params:[operationId, HEARTBEAT_OPERATION, scope, idem, requestHash, createdAt, slotKey, leaseId, authorityEpoch, STORAGE_SCOPE],
        },
        {
          sql:`UPDATE work_lease_slots
                  SET expires_at=$4,updated_at=now()
                WHERE work_ref=$1 AND gate=$2 AND lease_id=$3
                  AND EXISTS (SELECT 1 FROM operation_state WHERE operation_id=$5 AND state='prepared')
                RETURNING lease_id`,
          params:[slotKey, STORAGE_SCOPE, leaseId, newExpiresAt, operationId],
        },
        {
          sql:`UPDATE work_leases
                  SET expires_at=$2,last_heartbeat_at=$3,heartbeat_count=heartbeat_count+1,updated_at=now()
                WHERE lease_id=$1
                  AND claim_receipt->>'subject'='project_transition'
                  AND status='active'
                  AND EXISTS (SELECT 1 FROM work_lease_slots WHERE work_ref=$4 AND gate=$5 AND lease_id=$1 AND expires_at=$2)
                  AND EXISTS (SELECT 1 FROM operation_state WHERE operation_id=$6 AND state='prepared')
                RETURNING heartbeat_count`,
          params:[leaseId, newExpiresAt, createdAt, slotKey, STORAGE_SCOPE, operationId],
        },
        {
          sql:`UPDATE execution_state
                  SET recent_progress_sha256=CASE jsonb_array_length(recent_progress_sha256)
                        WHEN 0 THEN jsonb_build_array($4::text)
                        WHEN 1 THEN jsonb_build_array(recent_progress_sha256->>0,$4::text)
                        ELSE jsonb_build_array(recent_progress_sha256->>1,$4::text)
                      END,
                      heartbeat_count=heartbeat_count+1,
                      expires_at=$5,
                      last_heartbeat_at=$6,
                      updated_at=$6
                WHERE subject_key=$1 AND lease_ref=$2 AND ($3::bigint IS NULL OR authority_epoch=$3)
                  AND EXISTS (SELECT 1 FROM work_leases WHERE lease_id=$2 AND expires_at=$5 AND last_heartbeat_at=$6)
                  AND EXISTS (SELECT 1 FROM operation_state WHERE operation_id=$7 AND state='prepared')
                RETURNING heartbeat_count`,
          params:[slotKey, leaseId, authorityEpoch, progressSha, newExpiresAt, createdAt, operationId],
        },
        {
          sql:`UPDATE operation_state
                  SET state='succeeded',may_have_mutated=false,
                      mutation_certainty='definitely_not_mutated',
                      effect_kind='execution_heartbeat',effect_ref=$2,
                      result_sha256=$3,recovery_payload=NULL,
                      resolution=jsonb_build_object(
                        'previous_expires_at',$4::text,
                        'new_expires_at',$5::text,
                        'progress_sha256',$3::text,
                        'heartbeat_count',(SELECT heartbeat_count FROM execution_state WHERE subject_key=$6)
                      ),
                      resolved_at=$7
                WHERE operation_id=$1
                  AND EXISTS (
                    SELECT 1
                      FROM execution_state
                     WHERE subject_key=$6
                       AND lease_ref=$8
                       AND ($9::bigint IS NULL OR authority_epoch=$9)
                       AND expires_at=$5
                       AND last_heartbeat_at=$7
                  )
                RETURNING state,request_sha256,result_sha256,resolution`,
          params:[operationId, `lease:${leaseId}`, progressSha, previousExpiresAt, newExpiresAt, slotKey, createdAt, leaseId, authorityEpoch],
        },
        {
          sql:`SELECT 1 / CASE WHEN
                  NOT EXISTS (SELECT 1 FROM operation_state WHERE operation_id=$1)
                  OR EXISTS (SELECT 1 FROM operation_state WHERE operation_id=$1 AND state='succeeded' AND result_sha256=$2)
                THEN 1 ELSE 0 END AS atomicity_guard`,
          params:[operationId, progressSha],
        },
      ]);
      const saved = heartbeatFromOperation(tx?.results?.[5]?.rows?.[0] || null);
      if (saved) return saved;
      const existing = await operationByIdempotency(HEARTBEAT_OPERATION, leaseId, idem);
      if (existing) {
        if (String(existing.request_sha256 || '') !== requestHash) {
          throw Object.assign(new Error('project transition heartbeat idempotency conflict'), { code:'PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT' });
        }
        const replay = heartbeatFromOperation(existing);
        if (replay) return replay;
      }
      throw Object.assign(new Error('project transition lease or canonical execution authority could not be atomically extended'), { code:'PROJECT_TRANSITION_LEASE_STALE' });
    },
    async deleteSlot(slotKey, leaseId) {
      const result = await dbBinding.query(
        'DELETE FROM work_lease_slots WHERE work_ref=$1 AND gate=$2 AND lease_id=$3',
        [slotKey, STORAGE_SCOPE, leaseId],
      );
      return Number(result?.rowCount ?? result?.changes ?? 0);
    },
    async reconcileExpired(slotKey, leaseId, observedAtValue = new Date().toISOString()) {
      if (typeof dbBinding.transaction !== 'function') {
        throw Object.assign(new Error('project transition expiry recovery requires transactional storage'), { code:'PROJECT_TRANSITION_LEASE_RECOVERY_UNAVAILABLE' });
      }
      const observedAt = required(observedAtValue, 'observedAt');
      const currentExecution = await this.getExecutionState(slotKey);
      if (!currentExecution || String(currentExecution.lease_ref || '') !== String(leaseId)) {
        return Object.freeze({ released_without_linear_mutation:false, recovery_required:true, mutation_certainty:currentExecution?.mutation_certainty || 'may_have_mutated', reason:'PROJECT_TRANSITION_LEASE_ALREADY_RECOVERED', subject:'project_transition', lease_ref:String(leaseId), slot_key:String(slotKey), observed_at:observedAt });
      }
      const continuationExecutionFingerprint = currentExecution.transition_revision_fingerprint && currentExecution.transition_dependency_fingerprint
        ? await transitionExecutionFingerprint(currentExecution.transition_revision_fingerprint, currentExecution.transition_dependency_fingerprint)
        : null;
      const tx = await dbBinding.transaction([
        {
          sql:`UPDATE execution_state e
                  SET lifecycle=CASE
                        WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='confirmed_mutated' THEN 'effect_confirmed'
                        WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='may_have_mutated' THEN 'effect_uncertain'
                        ELSE 'effect_absent'
                      END,
                      mutation_certainty=COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated'),
                      lease_ref=CASE WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='definitely_not_mutated' THEN NULL ELSE e.lease_ref END,
                      run_id=CASE WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='definitely_not_mutated' THEN NULL ELSE e.run_id END,
                      expires_at=CASE WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='definitely_not_mutated' THEN NULL ELSE e.expires_at END,
                      hard_expires_at=CASE WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='definitely_not_mutated' THEN NULL ELSE e.hard_expires_at END,
                      active_capability_material=NULL,
                      continuation=CASE WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='definitely_not_mutated' AND e.checkpoint_sha256 IS NOT NULL AND $4::text IS NOT NULL THEN e.checkpoint ELSE e.continuation END,
                      continuation_sha256=CASE WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='definitely_not_mutated' AND e.checkpoint_sha256 IS NOT NULL AND $4::text IS NOT NULL THEN e.checkpoint_sha256 ELSE e.continuation_sha256 END,
                      continuation_execution_fingerprint=CASE WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='definitely_not_mutated' AND e.checkpoint_sha256 IS NOT NULL AND $4::text IS NOT NULL THEN $4 ELSE e.continuation_execution_fingerprint END,
                      checkpoint=CASE WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='definitely_not_mutated' THEN NULL ELSE e.checkpoint END,
                      checkpoint_sha256=CASE WHEN COALESCE(o.mutation_certainty,e.mutation_certainty,'definitely_not_mutated')='definitely_not_mutated' THEN NULL ELSE e.checkpoint_sha256 END,
                      updated_at=$3
                 FROM operation_state o
                WHERE e.subject_key=$1 AND e.subject_kind='project_transition' AND e.lease_ref=$2
                  AND o.operation_id=e.operation_id AND o.execution_id=e.execution_id
                RETURNING e.subject_key,e.execution_id,e.operation_id,e.lifecycle,e.mutation_certainty,e.lease_ref,e.run_id`,
          params:[slotKey, leaseId, observedAt, continuationExecutionFingerprint],
        },
        {
          sql:`UPDATE operation_state o
                  SET state=CASE WHEN e.mutation_certainty='definitely_not_mutated' THEN 'no_effect' WHEN e.mutation_certainty='confirmed_mutated' THEN 'succeeded' ELSE 'indeterminate' END,
                      may_have_mutated=e.mutation_certainty <> 'definitely_not_mutated',
                      mutation_certainty=e.mutation_certainty,
                      recovery_payload=CASE WHEN e.mutation_certainty='definitely_not_mutated' THEN NULL ELSE jsonb_build_object('schema','execution-recovery-v1','reason','lease_expired','confirm_only',true,'mutation_certainty',e.mutation_certainty) END,
                      resolution=CASE WHEN e.mutation_certainty='definitely_not_mutated' THEN jsonb_build_object('reason','lease_expired','mutation_certainty',e.mutation_certainty) ELSE NULL END,
                      resolved_at=CASE WHEN e.mutation_certainty='definitely_not_mutated' THEN $3 ELSE NULL END
                 FROM execution_state e
                WHERE e.subject_key=$1 AND e.execution_id=o.execution_id AND e.operation_id=o.operation_id
                  AND e.lifecycle IN ('effect_absent','effect_uncertain','effect_confirmed')
                  AND o.state IN ('prepared','indeterminate','succeeded')
                RETURNING o.operation_id,o.state,o.mutation_certainty`,
          params:[slotKey, leaseId, observedAt],
        },
        {
          sql:`UPDATE work_leases l
                  SET status='expired', reconciliation=jsonb_build_object('schema','project-transition-lease-reconciliation-v2','subject','project_transition','reason','LEASE_EXPIRED','observed_at',$3::text,'mutation_certainty',e.mutation_certainty,'recovery_required',e.mutation_certainty <> 'definitely_not_mutated'), updated_at=$3
                 FROM execution_state e
                WHERE l.lease_id=$2 AND l.work_ref=$1 AND l.gate=$4 AND l.claim_receipt->>'subject'='project_transition'
                  AND e.subject_key=$1 AND (e.lease_ref=$2 OR e.lease_ref IS NULL)`,
          params:[slotKey, leaseId, observedAt, STORAGE_SCOPE],
        },
        {
          sql:`DELETE FROM work_lease_slots WHERE work_ref=$1 AND lease_id=$2 AND gate=$3 RETURNING lease_id::text AS lease_id`,
          params:[slotKey, leaseId, STORAGE_SCOPE],
        },
        {
          sql:`SELECT 1 / CASE WHEN
                  EXISTS (
                    SELECT 1
                      FROM execution_state e
                      JOIN operation_state o
                        ON o.execution_id=e.execution_id
                       AND o.operation_id=e.operation_id
                     WHERE e.subject_key=$1
                       AND e.subject_kind='project_transition'
                       AND e.mutation_certainty=o.mutation_certainty
                       AND (
                         (e.mutation_certainty='definitely_not_mutated' AND e.lifecycle='effect_absent' AND o.state='no_effect' AND e.lease_ref IS NULL)
                         OR
                         (e.mutation_certainty='may_have_mutated' AND e.lifecycle='effect_uncertain' AND o.state='indeterminate' AND e.lease_ref=$2)
                         OR
                         (e.mutation_certainty='confirmed_mutated' AND e.lifecycle='effect_confirmed' AND o.state='succeeded' AND e.lease_ref=$2)
                       )
                  )
                  AND EXISTS (
                    SELECT 1
                      FROM work_leases l
                     WHERE l.lease_id=$2
                       AND l.work_ref=$1
                       AND l.gate=$3
                       AND l.status='expired'
                  )
                  AND NOT EXISTS (
                    SELECT 1
                      FROM work_lease_slots s
                     WHERE s.work_ref=$1
                       AND s.lease_id=$2
                       AND s.gate=$3
                  )
                THEN 1 ELSE 0 END AS atomicity_guard`,
          params:[slotKey, leaseId, STORAGE_SCOPE],
        },
      ]);
      const canonical = tx?.results?.[0]?.rows?.[0] || null;
      const atomicityGuard = tx?.results?.[4]?.rows?.[0]?.atomicity_guard;
      if (!canonical || Number(atomicityGuard) !== 1) {
        throw Object.assign(new Error('project transition canonical execution could not be expired safely'), { code:'PROJECT_TRANSITION_LEASE_STALE' });
      }
      const certainty = String(canonical.mutation_certainty || 'may_have_mutated');
      const released = certainty === 'definitely_not_mutated';
      return Object.freeze({ released_without_linear_mutation:released, recovery_required:!released, mutation_certainty:certainty, reason:released ? 'PROJECT_TRANSITION_LEASE_EXPIRED' : 'PROJECT_TRANSITION_EFFECT_CONFIRMATION_REQUIRED', subject:'project_transition', lease_ref:String(leaseId), slot_key:String(slotKey), observed_at:observedAt });
    },  });
}

export const projectTransitionLeasePersistence = Object.freeze({
  idempotency_prefix:IDEMPOTENCY_PREFIX,
  settle_idempotency_prefix:SETTLE_IDEMPOTENCY_PREFIX,
  storage_scope:STORAGE_SCOPE,
  checkpoint_operation:CHECKPOINT_OPERATION,
  heartbeat_checkpoint_operation:HEARTBEAT_CHECKPOINT_OPERATION,
  heartbeat_operation:HEARTBEAT_OPERATION,
  execution_fingerprint_schema:EXECUTION_FINGERPRINT_SCHEMA,
});