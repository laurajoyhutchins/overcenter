import { sha256Text } from './canonical-json.js';

const IDEMPOTENCY_PREFIX = 'project-transition:';
const SETTLE_IDEMPOTENCY_PREFIX = 'project-transition-settle:';
const MUTATION_GATE = 'lane:repo-implementation';

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

function defaultCapabilityFactory() {
  return `ptl_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
}

function uniqueViolation(error) {
  return error?.code === '23505' || error?.code === 'UNIQUE_VIOLATION';
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
  const acquireIdempotencyKey = required(row.acquire_idempotency_key, 'acquire_idempotency_key');
  const acquireRequestHash = required(row.acquire_request_hash, 'acquire_request_hash');

  const projectTransition = Object.freeze({
    project_ref:projectRef,
    transition_id:transitionId,
    repository,
    authority_revision:authorityRevision,
    authority_derivation:authorityDerivation,
    graph_fingerprint:graphFingerprint,
    slot_key:slotKey,
  });
  const claimReceipt = Object.freeze({
    schema:'project-transition-lease-claim-v1',
    subject:'project_transition',
    project_transition:projectTransition,
    execution_fingerprint:graphFingerprint,
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
    gate:MUTATION_GATE,
    run_id:runId,
    lease_token:capabilityToken,
    token_hash:await sha256Text(capabilityToken),
    claim_idempotency_key:`${IDEMPOTENCY_PREFIX}${acquireIdempotencyKey}`,
    claim_request_hash:acquireRequestHash,
    claim_request:claimRequest,
    status:row.status || 'active',
    created_at:required(row.created_at, 'created_at'),
    expires_at:required(row.expires_at, 'expires_at'),
    hard_expires_at:required(row.hard_expires_at, 'hard_expires_at'),
    previous_state:'PROJECT_TRANSITION',
    previous_state_id:'project_transition',
    previous_lane:MUTATION_GATE,
    previous_lane_id:'project_transition',
    claim_revision:authorityRevision,
    active_revision:authorityRevision,
    claim_receipt:claimReceipt,
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
    graph_fingerprint:String(subject.graph_fingerprint || ''),
    slot_key:String(subject.slot_key || row.work_ref || ''),
    status:String(row.status || ''),
    created_at:row.created_at,
    expires_at:row.expires_at,
    hard_expires_at:row.hard_expires_at,
    acquire_idempotency_key:claimKey.slice(IDEMPOTENCY_PREFIX.length),
    acquire_request_hash:String(row.claim_request_hash || ''),
    settle_idempotency_key:settleKey.startsWith(SETTLE_IDEMPOTENCY_PREFIX) ? settleKey.slice(SETTLE_IDEMPOTENCY_PREFIX.length) : (row.settle_idempotency_key || null),
    disposition:settlePlan?.disposition || null,
    settled_at:row.settled_at || null,
  });
}

export function createProjectTransitionLeasePostgresStore(dbBinding, options = {}) {
  if (!dbBinding || typeof dbBinding.query !== 'function') throw new TypeError('dbBinding is required');
  const capabilityFactory = options.capabilityFactory || defaultCapabilityFactory;
  async function one(sql, params = []) {
    const result = await dbBinding.query(sql, params);
    return result?.rows?.[0] || null;
  }
  async function subjectLease(sql, params) {
    return restoreProjectTransitionLease(await one(sql, params));
  }
  return Object.freeze({
    async getLease(leaseId) {
      return subjectLease(
        `SELECT * FROM work_leases WHERE lease_id=$1 AND claim_receipt->>'subject' = 'project_transition' LIMIT 1`,
        [leaseId],
      );
    },
    async getLeaseByAcquireIdempotency(idempotencyKey) {
      return subjectLease(
        `SELECT * FROM work_leases WHERE claim_idempotency_key=$1 AND claim_receipt->>'subject' = 'project_transition' LIMIT 1`,
        [`${IDEMPOTENCY_PREFIX}${idempotencyKey}`],
      );
    },
    async getSlot(slotKey) {
      return one(
        `SELECT s.work_ref AS slot_key, s.lease_id::text AS lease_id, s.expires_at
           FROM work_lease_slots s
           JOIN work_leases l ON l.lease_id=s.lease_id
          WHERE s.work_ref=$1 AND s.gate=$2 AND l.claim_receipt->>'subject' = 'project_transition'
          LIMIT 1`,
        [slotKey, MUTATION_GATE],
      );
    },
    async getRun(runId) {
      return one('SELECT run_id,status,deadline_at FROM orchestration_runs WHERE run_id=$1 LIMIT 1', [runId]);
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
          [row.slot_key, MUTATION_GATE, row.lease_id, row.expires_at],
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
        const settlePlan = { schema:'project-transition-lease-settlement-plan-v1', subject:'project_transition', disposition };
        const settleReceipt = {
          schema:'project-transition-lease-settlement-v1',
          subject:'project_transition',
          lease_ref:String(leaseId),
          project_transition:claimReceipt?.project_transition || null,
          disposition,
          settled_at:settledAt,
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
    async deleteSlot(slotKey, leaseId) {
      const result = await dbBinding.query(
        'DELETE FROM work_lease_slots WHERE work_ref=$1 AND gate=$2 AND lease_id=$3',
        [slotKey, MUTATION_GATE, leaseId],
      );
      return Number(result?.rowCount ?? result?.changes ?? 0);
    },
  });
}

export const projectTransitionLeasePersistence = Object.freeze({
  idempotency_prefix:IDEMPOTENCY_PREFIX,
  settle_idempotency_prefix:SETTLE_IDEMPOTENCY_PREFIX,
  mutation_gate:MUTATION_GATE,
});