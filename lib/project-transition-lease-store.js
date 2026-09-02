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

async function compactTransitionExecutionFingerprint(revisionFingerprint, dependencyFingerprint) {
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
    ...(epoch(row.authority_epoch) > 0 ? { authority_epoch:epoch(row.authority_epoch) } : {}),
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
    settled_at:row.settled_at || null,
    graph_revision_change:settleReceipt?.graph_revision_change || null,
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
                 subject_key,run_id,lease_epoch,authority_revision,may_have_mutated,created_at
               )
               SELECT $1,$2,$3,$4,$5,'prepared',subject_key,run_id,authority_epoch,authority_revision,false,$6
                 FROM execution_state
                WHERE lease_ref=$7
               ON CONFLICT (command,idempotency_scope,idempotency_key) DO NOTHING
               RETURNING operation_id`,
          params:[operationId, operationCommand, scope, idem, requestHash, createdAt, leaseId],
        },
        {
          sql:`UPDATE execution_state
                  SET checkpoint=$2::jsonb,checkpoint_sha256=$3,updated_at=$4
                WHERE lease_ref=$1
                  AND EXISTS (SELECT 1 FROM operation_state WHERE operation_id=$5 AND state='prepared')
                RETURNING subject_key`,
          params:[leaseId, JSON.stringify(checkpoint), checkpointSha, createdAt, operationId],
        },
        {
          sql:`UPDATE operation_state
                  SET state='succeeded',may_have_mutated=true,
                      effect_kind='execution_checkpoint',effect_ref=$2,
                      result_sha256=$3,recovery_payload=NULL,
                      resolution=jsonb_build_object('checkpoint_sha256',$3::text),resolved_at=$4
                WHERE operation_id=$1
                  AND EXISTS (SELECT 1 FROM execution_state WHERE lease_ref=$5 AND checkpoint_sha256=$3)
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
      throw Object.assign(new Error('project transition checkpoint used stale compact authority'), { code:'PROJECT_TRANSITION_LEASE_STALE' });
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
               subject_key,subject_kind,project_ref,transition_id,authority_epoch,lease_ref,run_id,
               authority_repository,authority_revision,graph_fingerprint,transition_revision_fingerprint,
               transition_dependency_fingerprint,expires_at,hard_expires_at,active_capability_material,
               checkpoint,checkpoint_sha256,recent_progress_sha256,heartbeat_count,last_heartbeat_at,updated_at
             ) VALUES (
               $1,'project_transition',$2,$3,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
               NULL,NULL,'[]'::jsonb,0,NULL,$4
             )
             ON CONFLICT (subject_key) DO UPDATE SET
               project_ref=EXCLUDED.project_ref,
               transition_id=EXCLUDED.transition_id,
               authority_epoch=execution_state.authority_epoch+1,
               lease_ref=EXCLUDED.lease_ref,
               run_id=EXCLUDED.run_id,
               authority_repository=EXCLUDED.authority_repository,
               authority_revision=EXCLUDED.authority_revision,
               graph_fingerprint=EXCLUDED.graph_fingerprint,
               transition_revision_fingerprint=EXCLUDED.transition_revision_fingerprint,
               transition_dependency_fingerprint=EXCLUDED.transition_dependency_fingerprint,
               expires_at=EXCLUDED.expires_at,
               hard_expires_at=EXCLUDED.hard_expires_at,
               active_capability_material=EXCLUDED.active_capability_material,
               checkpoint=NULL,
               checkpoint_sha256=NULL,
               recent_progress_sha256='[]'::jsonb,
               heartbeat_count=0,
               last_heartbeat_at=NULL,
               updated_at=EXCLUDED.updated_at
             WHERE execution_state.lease_ref IS NULL
               AND execution_state.subject_kind='project_transition'
             RETURNING authority_epoch`,
            params,
          },
          {
            sql:`INSERT INTO work_leases (
               lease_id,work_ref,gate,run_id,lease_token,token_hash,claim_idempotency_key,claim_request_hash,
               status,created_at,expires_at,previous_state,previous_state_id,previous_lane,previous_lane_id,
               claim_revision,active_revision,claim_receipt,claim_request,hard_expires_at
             )
             SELECT $5,$15,$16,$6,$14,$17,$18,$19,$20,$4,$12,$21,$22,$23,$24,$25,$26,
                    jsonb_set($27::jsonb,'{project_transition,authority_epoch}',to_jsonb(execution_state.authority_epoch),true),
                    $28::jsonb,$13
               FROM execution_state
              WHERE subject_key=$1 AND lease_ref=$5 AND run_id=$6
             RETURNING *`,
            params,
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
                   EXISTS (SELECT 1 FROM execution_state WHERE subject_key=$1 AND lease_ref=$2 AND run_id=$3)
                   AND EXISTS (SELECT 1 FROM work_lease_slots WHERE work_ref=$1 AND gate='project_transition' AND lease_id=$2)
                 THEN 1 ELSE 0 END AS atomicity_guard`,
            params:[subjectKey,persisted.lease_id,persisted.run_id],
          },
        ]);
        const inserted = tx?.results?.[1]?.rows?.[0] || null;
        if (!inserted) {
          const conflict = new Error('project transition compact authority is already occupied');
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
        const settlePlan = { schema:'project-transition-lease-settlement-plan-v1', subject:'project_transition', disposition };
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
      const continuationExecutionFingerprint = input?.continuation_execution_fingerprint
        ? required(input.continuation_execution_fingerprint, 'continuation_execution_fingerprint')
        : await compactTransitionExecutionFingerprint(input?.transition_revision_fingerprint, input?.transition_dependency_fingerprint);
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
      const settlePlan = { schema:'project-transition-lease-settlement-plan-v1', subject:'project_transition', disposition };
      const settleReceipt = {
        schema:'project-transition-lease-settlement-v1',
        subject:'project_transition',
        lease_ref:leaseId,
        project_transition:projectTransition,
        disposition,
        settled_at:settledAt,
        graph_revision_change:input?.graph_revision_change || null,
      };
      const tx = await dbBinding.transaction([
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
          sql:`UPDATE execution_state
                  SET no_progress_streak=CASE
                        WHEN checkpoint_sha256 IS NULL THEN no_progress_streak
                        WHEN continuation_sha256=checkpoint_sha256 AND continuation_execution_fingerprint=$6 THEN no_progress_streak+1
                        ELSE 0
                      END,
                      continuation=CASE WHEN checkpoint_sha256 IS NULL THEN continuation ELSE checkpoint END,
                      continuation_sha256=CASE WHEN checkpoint_sha256 IS NULL THEN continuation_sha256 ELSE checkpoint_sha256 END,
                      continuation_execution_fingerprint=CASE WHEN checkpoint_sha256 IS NULL THEN continuation_execution_fingerprint ELSE $6 END,
                      lease_ref=NULL, run_id=NULL, authority_repository=NULL, authority_revision=NULL,
                      graph_fingerprint=NULL, transition_revision_fingerprint=NULL,
                      transition_dependency_fingerprint=NULL, expires_at=NULL, hard_expires_at=NULL,
                      active_capability_material=NULL, checkpoint=NULL, checkpoint_sha256=NULL,
                      recent_progress_sha256='[]'::jsonb, heartbeat_count=0, last_heartbeat_at=NULL,
                      updated_at=$5
                WHERE subject_key=$1 AND lease_ref=$2 AND authority_epoch=$3
                  AND EXISTS (SELECT 1 FROM work_leases l WHERE l.lease_id=$2 AND l.status='settled' AND l.settle_idempotency_key=$4)
                RETURNING subject_key,continuation,continuation_sha256,continuation_execution_fingerprint,no_progress_streak`,
          params:[slotKey, leaseId, authorityEpoch, settleKey, settledAt, continuationExecutionFingerprint],
        },
        {
          sql:`SELECT 1 / CASE WHEN
                  EXISTS (SELECT 1 FROM work_leases l WHERE l.lease_id=$1 AND l.work_ref=$2 AND l.gate=$3 AND l.run_id=$4 AND l.status='settled' AND l.settle_idempotency_key=$5 AND l.settle_plan->>'disposition'=$6)
                  AND NOT EXISTS (SELECT 1 FROM work_lease_slots s WHERE s.work_ref=$2 AND s.gate=$3 AND s.lease_id=$1)
                  AND ($7=0 OR EXISTS (SELECT 1 FROM execution_state e WHERE e.subject_key=$2 AND e.authority_epoch=$7 AND e.lease_ref IS NULL))
                THEN 1 ELSE 0 END AS atomicity_guard`,
          params:[leaseId, slotKey, STORAGE_SCOPE, runId, settleKey, disposition, authorityEpoch],
        },
      ]);
      const updated = tx?.results?.[0]?.rows?.[0] || null;
      if (updated) return restoreProjectTransitionLease(updated);
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
                 subject_key,run_id,lease_epoch,authority_revision,may_have_mutated,created_at
               )
               SELECT $1,$2,$3,$4,$5,'prepared',e.subject_key,e.run_id,e.authority_epoch,e.authority_revision,false,$6
                 FROM execution_state e
                 JOIN work_leases l ON l.lease_id=e.lease_ref
                 JOIN work_lease_slots s ON s.lease_id=l.lease_id AND s.work_ref=e.subject_key AND s.gate=$10
                WHERE e.subject_key=$7 AND e.lease_ref=$8 AND ($9::bigint IS NULL OR e.authority_epoch=$9)
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
                  SET state='succeeded',may_have_mutated=true,
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
                  AND EXISTS (SELECT 1 FROM execution_state WHERE subject_key=$6 AND lease_ref=$8 AND ($9::bigint IS NULL OR authority_epoch=$9) AND expires_at=$5 AND last_heartbeat_at=$7)
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
      throw Object.assign(new Error('project transition lease or compact authority could not be atomically extended'), { code:'PROJECT_TRANSITION_LEASE_STALE' });
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
      const continuationExecutionFingerprint = currentExecution
        && String(currentExecution.lease_ref || '') === String(leaseId)
        && currentExecution.transition_revision_fingerprint
        && currentExecution.transition_dependency_fingerprint
        ? await compactTransitionExecutionFingerprint(currentExecution.transition_revision_fingerprint, currentExecution.transition_dependency_fingerprint)
        : null;
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
        {
          sql:`UPDATE execution_state e
                  SET no_progress_streak=CASE
                        WHEN checkpoint_sha256 IS NULL OR $4::text IS NULL THEN no_progress_streak
                        WHEN continuation_sha256=checkpoint_sha256 AND continuation_execution_fingerprint=$4 THEN no_progress_streak+1
                        ELSE 0
                      END,
                      continuation=CASE WHEN checkpoint_sha256 IS NULL OR $4::text IS NULL THEN continuation ELSE checkpoint END,
                      continuation_sha256=CASE WHEN checkpoint_sha256 IS NULL OR $4::text IS NULL THEN continuation_sha256 ELSE checkpoint_sha256 END,
                      continuation_execution_fingerprint=CASE WHEN checkpoint_sha256 IS NULL OR $4::text IS NULL THEN continuation_execution_fingerprint ELSE $4 END,
                      lease_ref=NULL, run_id=NULL, authority_repository=NULL, authority_revision=NULL,
                      graph_fingerprint=NULL, transition_revision_fingerprint=NULL,
                      transition_dependency_fingerprint=NULL, expires_at=NULL, hard_expires_at=NULL,
                      active_capability_material=NULL, checkpoint=NULL, checkpoint_sha256=NULL,
                      recent_progress_sha256='[]'::jsonb, heartbeat_count=0, last_heartbeat_at=NULL,
                      updated_at=$3
                WHERE e.subject_key=$1 AND e.lease_ref=$2
                  AND e.authority_epoch = COALESCE((
                    SELECT NULLIF(l.claim_receipt->'project_transition'->>'authority_epoch','')::bigint
                      FROM work_leases l WHERE l.lease_id=$2
                  ), -1)
                RETURNING e.subject_key,e.continuation,e.continuation_sha256,e.continuation_execution_fingerprint,e.no_progress_streak`,
          params:[slotKey, leaseId, observedAt, continuationExecutionFingerprint],
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
  checkpoint_operation:CHECKPOINT_OPERATION,
  heartbeat_checkpoint_operation:HEARTBEAT_CHECKPOINT_OPERATION,
  heartbeat_operation:HEARTBEAT_OPERATION,
  execution_fingerprint_schema:EXECUTION_FINGERPRINT_SCHEMA,
});
