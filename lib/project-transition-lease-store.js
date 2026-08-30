import { sha256Text } from './canonical-json.js';

const IDEMPOTENCY_PREFIX = 'project-transition:';
const SETTLE_IDEMPOTENCY_PREFIX = 'project-transition-settle:';
const STORAGE_SCOPE = 'project_transition';

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
  const transitionDefinitionFingerprint = required(row.transition_definition_fingerprint, 'transition_definition_fingerprint');
  const transitionRevisionFingerprint = required(row.transition_revision_fingerprint, 'transition_revision_fingerprint');
  const transitionDependencyFingerprint = required(row.transition_dependency_fingerprint, 'transition_dependency_fingerprint');
  const acquireIdempotencyKey = required(row.acquire_idempotency_key, 'acquire_idempotency_key');
  const acquireRequestHash = required(row.acquire_request_hash, 'acquire_request_hash');

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
    gate:STORAGE_SCOPE,
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
    previous_lane:STORAGE_SCOPE,
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
    settled_at:row.settled_at || null,
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
    async getActiveLeasesForTransition(projectRef, transitionId, observedAt) {
      const rows = await many(
        `SELECT *
           FROM work_leases
          WHERE gate=$1
            AND claim_receipt->>'subject' = 'project_transition'
            AND claim_receipt->'project_transition'->>'project_ref' = $2
            AND claim_receipt->'project_transition'->>'transition_id' = $3
            AND status='active'
            AND expires_at > $4
          ORDER BY created_at ASC, lease_id ASC
          LIMIT 8`,
        [STORAGE_SCOPE, required(projectRef, 'projectRef'), required(transitionId, 'transitionId'), required(observedAt, 'observedAt')],
      );
      return rows.map(restoreProjectTransitionLease).filter(Boolean);
    },
    async getSlot(slotKey) {
      return one(
        `SELECT s.work_ref AS slot_key, s.lease_id::text AS lease_id, s.expires_at
           FROM work_lease_slots s
           JOIN work_leases l ON l.lease_id=s.lease_id
          WHERE s.work_ref=$1 AND s.gate=$2 AND l.claim_receipt->>'subject' = 'project_transition'
          LIMIT 1`,
        [slotKey, STORAGE_SCOPE],
      );
    },
    async getRun(runId) {
      return one('SELECT run_id,status,deadline_at,settlement_reserve_seconds FROM orchestration_runs WHERE run_id=$1 LIMIT 1', [runId]);
    },
    async getCheckpointByIdempotency(leaseId, key) {
      return one('SELECT * FROM work_lease_checkpoints WHERE lease_id=$1 AND idempotency_key=$2', [leaseId, key]);
    },
    async getLatestCheckpoint(leaseId) {
      return one('SELECT * FROM work_lease_checkpoints WHERE lease_id=$1 ORDER BY created_at DESC LIMIT 1', [leaseId]);
    },
    async getHeartbeatByIdempotency(leaseId, key) {
      return one('SELECT * FROM work_lease_heartbeats WHERE lease_id=$1 AND idempotency_key=$2', [leaseId, key]);
    },
    async listRecentHeartbeats(leaseId, limit = 2) {
      return many(`SELECT * FROM work_lease_heartbeats WHERE lease_id=$1 ORDER BY created_at DESC LIMIT ${Math.min(20, Math.max(1, Number(limit) || 2))}`, [leaseId]);
    },
    async insertCheckpoint(leaseId, idem, requestHash, checkpoint, checkpointSha, createdAt) {
      const inserted = await one(
        'INSERT INTO work_lease_checkpoints (lease_id,idempotency_key,request_sha256,checkpoint,checkpoint_sha256,created_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT (lease_id,idempotency_key) DO NOTHING RETURNING *',
        [leaseId, idem, requestHash, JSON.stringify(checkpoint), checkpointSha, createdAt],
      );
      if (inserted) return inserted;
      const existing = await this.getCheckpointByIdempotency(leaseId, idem);
      if (existing?.request_sha256 === requestHash) return existing;
      throw Object.assign(new Error('project transition checkpoint idempotency conflict'), { code:'PROJECT_TRANSITION_IDEMPOTENCY_CONFLICT' });
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
    async extendLeaseWithHeartbeat(input) {
      if (typeof dbBinding.transaction !== 'function') {
        throw Object.assign(new Error('project transition heartbeat persistence requires transactional storage'), { code:'PROJECT_TRANSITION_HEARTBEAT_STORAGE_UNAVAILABLE' });
      }
      const attemptToken = crypto.randomUUID();
      const params = [input.lease_id, input.slot_key, STORAGE_SCOPE, input.idempotency_key, input.request_sha256, input.progress_sha256, input.new_expires_at, input.created_at, input.previous_expires_at, attemptToken];
      const tx = await dbBinding.transaction([
        {
          sql:`SELECT l.lease_id FROM work_leases l JOIN work_lease_slots s ON s.lease_id=l.lease_id AND s.work_ref=$2 AND s.gate=$3 WHERE l.lease_id=$1 AND l.claim_receipt->>'subject'='project_transition' AND l.status='active' AND l.expires_at>$8 AND s.expires_at>$8 FOR UPDATE OF l,s`,
          params,
        },
        {
          sql:`INSERT INTO work_lease_heartbeats (lease_id,idempotency_key,request_sha256,progress_sha256,previous_expires_at,new_expires_at,created_at,attempt_token) SELECT $1,$4,$5,$6,$9,$7,$8,$10 WHERE EXISTS (SELECT 1 FROM work_leases l JOIN work_lease_slots s ON s.lease_id=l.lease_id AND s.work_ref=$2 AND s.gate=$3 WHERE l.lease_id=$1 AND l.claim_receipt->>'subject'='project_transition' AND l.status='active' AND l.expires_at>$8 AND s.expires_at>$8) ON CONFLICT (lease_id,idempotency_key) DO NOTHING RETURNING *`,
          params,
        },
        {
          sql:`UPDATE work_lease_slots s SET expires_at=$7,updated_at=now() WHERE s.lease_id=$1 AND s.work_ref=$2 AND s.gate=$3 AND s.expires_at>$8 AND EXISTS (SELECT 1 FROM work_lease_heartbeats h WHERE h.lease_id=$1 AND h.idempotency_key=$4 AND h.request_sha256=$5 AND h.attempt_token=$10) RETURNING s.lease_id`,
          params,
        },
        {
          sql:`UPDATE work_leases l SET expires_at=$7,last_heartbeat_at=$8,heartbeat_count=heartbeat_count+1,updated_at=now() WHERE l.lease_id=$1 AND l.claim_receipt->>'subject'='project_transition' AND l.status='active' AND l.expires_at>$8 AND EXISTS (SELECT 1 FROM work_lease_slots s WHERE s.lease_id=$1 AND s.work_ref=$2 AND s.gate=$3 AND s.expires_at=$7) AND EXISTS (SELECT 1 FROM work_lease_heartbeats h WHERE h.lease_id=$1 AND h.idempotency_key=$4 AND h.request_sha256=$5 AND h.attempt_token=$10) RETURNING l.heartbeat_count`,
          params,
        },
        {
          sql:`SELECT 1 / CASE WHEN NOT EXISTS (SELECT 1 FROM work_lease_heartbeats h WHERE h.lease_id=$1 AND h.idempotency_key=$4 AND h.attempt_token=$10) OR (EXISTS (SELECT 1 FROM work_leases l WHERE l.lease_id=$1 AND l.expires_at=$7 AND l.last_heartbeat_at=$8) AND EXISTS (SELECT 1 FROM work_lease_slots s WHERE s.lease_id=$1 AND s.work_ref=$2 AND s.gate=$3 AND s.expires_at=$7)) THEN 1 ELSE 0 END AS atomicity_guard`,
          params,
        },
      ]);
      const reservation=tx?.results?.[1]?.rows?.[0]||null, slot=tx?.results?.[2]?.rows?.[0]||null, lease=tx?.results?.[3]?.rows?.[0]||null;
      if (reservation && slot && lease) return { ...reservation, heartbeat_count:Number(lease.heartbeat_count || 0) };
      const existing = await this.getHeartbeatByIdempotency(input.lease_id, input.idempotency_key);
      if (existing?.request_sha256 === input.request_sha256) return existing;
      throw Object.assign(new Error('project transition lease or slot could not be atomically extended'), { code:'PROJECT_TRANSITION_LEASE_STALE' });
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
      const reconciliation = JSON.stringify({
        schema:'project-transition-lease-reconciliation-v1',
        subject:'project_transition',
        reason:'LEASE_EXPIRED',
        observed_at:observedAt,
      });
      const tx = await dbBinding.transaction([
        {
          sql:`UPDATE work_leases
                 SET status='expired', reconciliation=$4::jsonb, updated_at=$3
               WHERE lease_id=$2 AND work_ref=$1 AND gate=$5
                 AND claim_receipt->>'subject' = 'project_transition'
                 AND status='active' AND expires_at <= $3
               RETURNING lease_id::text AS lease_id`,
          params:[slotKey, leaseId, observedAt, reconciliation, STORAGE_SCOPE],
        },
        {
          sql:`DELETE FROM work_lease_slots s
               WHERE s.work_ref=$1 AND s.lease_id=$2 AND s.expires_at <= $3 AND s.gate=$4
                 AND EXISTS (
                   SELECT 1 FROM work_leases l
                    WHERE l.lease_id=s.lease_id AND l.claim_receipt->>'subject' = 'project_transition'
                 )
               RETURNING s.lease_id::text AS lease_id`,
          params:[slotKey, leaseId, observedAt, STORAGE_SCOPE],
        },
      ]);
      const leaseUpdated = Boolean(tx?.results?.[0]?.rows?.[0]);
      const slotDeleted = Boolean(tx?.results?.[1]?.rows?.[0]);
      return Object.freeze({
        released_without_linear_mutation:true,
        reason:leaseUpdated || slotDeleted ? 'PROJECT_TRANSITION_LEASE_EXPIRED' : 'PROJECT_TRANSITION_LEASE_ALREADY_RECOVERED',
        subject:'project_transition',
        lease_ref:String(leaseId),
        slot_key:String(slotKey),
        observed_at:observedAt,
      });
    },
  });
}

export const projectTransitionLeasePersistence = Object.freeze({
  idempotency_prefix:IDEMPOTENCY_PREFIX,
  settle_idempotency_prefix:SETTLE_IDEMPOTENCY_PREFIX,
  storage_scope:STORAGE_SCOPE,
});
