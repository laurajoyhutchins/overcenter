import { canonicalJson } from '../../semantic/canonical-json.js';
import {
  assertExecutionState,
  assertTerminalOperationCompactable,
  type ExecutionState,
  type OperationLifecycleState,
  type OperationState,
  type ProofState,
} from '../../semantic/compact-execution-state.js';
import type {
  AcquireExecutionInput,
  CompactExecutionStateStore,
  CompactRunInput,
  HeartbeatExecutionInput,
  MarkOperationIndeterminateInput,
  PrepareOperationInput,
  PutProofInput,
  ResolveOperationInput,
  SettleExecutionInput,
  WriteCheckpointInput,
} from '../../ports/compact-execution-state-store.js';
import type { NodePostgresClient } from './node-postgres-runtime.js';

type Row = Record<string, unknown>;

function fail(code:string, message:string, details:unknown = null):never {
  throw Object.assign(new Error(message), { code, details });
}

function requiredText(value:unknown, field:string):string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fail('COMPACT_STATE_INVALID', `${field} is required`, { field });
  return text;
}

function optionalText(value:unknown):string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function integer(value:unknown, field:string):number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fail('COMPACT_STATE_INVALID', `${field} must be a non-negative safe integer`, { field, value });
  }
  return parsed;
}

function iso(value:unknown, field:string):string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const text = requiredText(value, field);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) return fail('COMPACT_STATE_INVALID', `${field} must be an instant`, { field, value });
  return new Date(millis).toISOString();
}

function optionalIso(value:unknown, field:string):string | null {
  return value == null ? null : iso(value, field);
}

function requireSha(value:string, field:string):string {
  if (!/^[0-9a-f]{64}$/.test(value)) return fail('COMPACT_STATE_INVALID', `${field} must be a lowercase SHA-256`, { field });
  return value;
}

function executionFromRow(row:Row):ExecutionState {
  const state:ExecutionState = {
    subject_key:requiredText(row.subject_key, 'subject_key'),
    subject_kind:row.subject_kind === 'project_transition' ? 'project_transition' : row.subject_kind === 'legacy_work' ? 'legacy_work' : fail('COMPACT_STATE_INVALID', 'subject_kind is invalid'),
    project_ref:optionalText(row.project_ref),
    transition_id:optionalText(row.transition_id),
    authority_epoch:integer(row.authority_epoch, 'authority_epoch'),
    lease_ref:optionalText(row.lease_ref),
    run_id:optionalText(row.run_id),
    authority_repository:optionalText(row.authority_repository),
    authority_revision:optionalText(row.authority_revision),
    graph_fingerprint:optionalText(row.graph_fingerprint),
    transition_revision_fingerprint:optionalText(row.transition_revision_fingerprint),
    transition_dependency_fingerprint:optionalText(row.transition_dependency_fingerprint),
    expires_at:optionalIso(row.expires_at, 'expires_at'),
    hard_expires_at:optionalIso(row.hard_expires_at, 'hard_expires_at'),
    active_capability_material:optionalText(row.active_capability_material),
    checkpoint:row.checkpoint ?? null,
    checkpoint_sha256:optionalText(row.checkpoint_sha256),
    recent_progress_sha256:Array.isArray(row.recent_progress_sha256) ? row.recent_progress_sha256.map(String) as ExecutionState['recent_progress_sha256'] : fail('COMPACT_STATE_INVALID', 'recent_progress_sha256 must be an array'),
    heartbeat_count:integer(row.heartbeat_count, 'heartbeat_count'),
    last_heartbeat_at:optionalIso(row.last_heartbeat_at, 'last_heartbeat_at'),
    continuation:row.continuation ?? null,
    continuation_sha256:optionalText(row.continuation_sha256),
    continuation_execution_fingerprint:optionalText(row.continuation_execution_fingerprint),
    no_progress_streak:integer(row.no_progress_streak, 'no_progress_streak'),
    updated_at:iso(row.updated_at, 'updated_at'),
  };
  assertExecutionState(state);
  return state;
}

const OPERATION_STATES = new Set<OperationLifecycleState>(['prepared', 'indeterminate', 'succeeded', 'no_effect', 'rejected']);

function operationFromRow(row:Row):OperationState {
  const state = String(row.state || '') as OperationLifecycleState;
  if (!OPERATION_STATES.has(state)) fail('COMPACT_STATE_INVALID', 'operation state is invalid', { state });
  return {
    operation_id:requiredText(row.operation_id, 'operation_id'),
    command:requiredText(row.command, 'command'),
    idempotency_scope:requiredText(row.idempotency_scope, 'idempotency_scope'),
    idempotency_key:requiredText(row.idempotency_key, 'idempotency_key'),
    request_sha256:requireSha(requiredText(row.request_sha256, 'request_sha256'), 'request_sha256'),
    state,
    subject_key:optionalText(row.subject_key),
    run_id:optionalText(row.run_id),
    lease_epoch:row.lease_epoch == null ? null : integer(row.lease_epoch, 'lease_epoch'),
    authority_revision:optionalText(row.authority_revision),
    may_have_mutated:Boolean(row.may_have_mutated),
    effect_kind:optionalText(row.effect_kind),
    effect_ref:optionalText(row.effect_ref),
    effect_sha256:optionalText(row.effect_sha256),
    result_sha256:optionalText(row.result_sha256),
    recovery_payload:row.recovery_payload ?? null,
    resolution:row.resolution ?? null,
    created_at:iso(row.created_at, 'created_at'),
    resolved_at:optionalIso(row.resolved_at, 'resolved_at'),
  };
}

function proofFromRow(row:Row):ProofState {
  const refs = row.evidence_refs;
  if (!Array.isArray(refs)) fail('COMPACT_STATE_INVALID', 'proof evidence_refs must be an array');
  return {
    proof_key:requiredText(row.proof_key, 'proof_key'),
    subject_key:requiredText(row.subject_key, 'subject_key'),
    predicate_kind:requiredText(row.predicate_kind, 'predicate_kind'),
    authority_repository:requiredText(row.authority_repository, 'authority_repository'),
    authority_revision:requiredText(row.authority_revision, 'authority_revision'),
    evidence_sha256:requireSha(requiredText(row.evidence_sha256, 'evidence_sha256'), 'evidence_sha256'),
    evidence_refs:refs.map((ref) => {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('COMPACT_STATE_INVALID', 'proof evidence ref is invalid');
      const record = ref as Row;
      return { kind:requiredText(record.kind, 'evidence_ref.kind'), ref:requiredText(record.ref, 'evidence_ref.ref') };
    }),
    satisfied_at:iso(row.satisfied_at, 'satisfied_at'),
    consumed_at:optionalIso(row.consumed_at, 'consumed_at'),
  };
}

function first<RowType extends Row>(rows:readonly RowType[]):RowType | null {
  return rows[0] ?? null;
}

function stale(subjectKey:string, leaseRef:string, authorityEpoch:number):never {
  return fail('EXECUTION_AUTHORITY_STALE', 'compact execution authority no longer matches the requested lease epoch', {
    subject_key:subjectKey, lease_ref:leaseRef, authority_epoch:authorityEpoch,
  });
}

export function createPostgresCompactExecutionStateStore(client:NodePostgresClient):CompactExecutionStateStore {
  return {
    async getExecution(subjectKey) {
      const result = await client.query<Row>('SELECT * FROM execution_state WHERE subject_key=$1 LIMIT 1', [subjectKey]);
      const row = first(result.rows);
      return row ? executionFromRow(row) : null;
    },

    async acquireExecution(input:AcquireExecutionInput) {
      const result = await client.query<Row>(
        `INSERT INTO execution_state (
           subject_key,subject_kind,project_ref,transition_id,authority_epoch,lease_ref,run_id,
           authority_repository,authority_revision,graph_fingerprint,transition_revision_fingerprint,
           transition_dependency_fingerprint,expires_at,hard_expires_at,active_capability_material,updated_at
         ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (subject_key) DO UPDATE SET
           subject_kind=EXCLUDED.subject_kind,
           project_ref=EXCLUDED.project_ref,
           transition_id=EXCLUDED.transition_id,
           authority_epoch=execution_state.authority_epoch + 1,
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
            OR execution_state.expires_at <= $16::timestamptz
            OR execution_state.hard_expires_at <= $16::timestamptz
         RETURNING *`,
        [
          input.subject_key,input.subject_kind,input.project_ref,input.transition_id,input.lease_ref,input.run_id,
          input.authority_repository,input.authority_revision,input.graph_fingerprint,input.transition_revision_fingerprint,
          input.transition_dependency_fingerprint,input.expires_at,input.hard_expires_at,input.active_capability_material,
          input.observed_at,input.observed_at,
        ],
      );
      const row = first(result.rows);
      if (!row) return fail('EXECUTION_AUTHORITY_CONFLICT', 'execution subject already has active authority', { subject_key:input.subject_key });
      return executionFromRow(row);
    },

    async writeCheckpoint(input:WriteCheckpointInput) {
      requireSha(input.checkpoint_sha256, 'checkpoint_sha256');
      const result = await client.query<Row>(
        `UPDATE execution_state
            SET checkpoint=$4::jsonb, checkpoint_sha256=$5, updated_at=$6
          WHERE subject_key=$1 AND lease_ref=$2 AND authority_epoch=$3
          RETURNING *`,
        [input.subject_key,input.lease_ref,input.authority_epoch,JSON.stringify(input.checkpoint),input.checkpoint_sha256,input.updated_at],
      );
      const row = first(result.rows);
      if (!row) return stale(input.subject_key,input.lease_ref,input.authority_epoch);
      return executionFromRow(row);
    },

    async heartbeatExecution(input:HeartbeatExecutionInput) {
      requireSha(input.progress_sha256, 'progress_sha256');
      const result = await client.query<Row>(
        `UPDATE execution_state
            SET recent_progress_sha256 = CASE
                  WHEN jsonb_array_length(recent_progress_sha256)=0 THEN jsonb_build_array($4::text)
                  ELSE jsonb_build_array(recent_progress_sha256->>-1, $4::text)
                END,
                heartbeat_count=heartbeat_count + 1,
                last_heartbeat_at=$6,
                expires_at=$5,
                updated_at=$6
          WHERE subject_key=$1 AND lease_ref=$2 AND authority_epoch=$3
            AND $5::timestamptz >= expires_at
            AND $5::timestamptz <= hard_expires_at
          RETURNING *`,
        [input.subject_key,input.lease_ref,input.authority_epoch,input.progress_sha256,input.expires_at,input.heartbeat_at],
      );
      const row = first(result.rows);
      if (!row) return stale(input.subject_key,input.lease_ref,input.authority_epoch);
      return executionFromRow(row);
    },

    async settleExecution(input:SettleExecutionInput) {
      if (!Number.isSafeInteger(input.no_progress_streak) || input.no_progress_streak < 0) fail('COMPACT_STATE_INVALID', 'no_progress_streak must be non-negative');
      const result = await client.query<Row>(
        `UPDATE execution_state SET
           lease_ref=NULL, run_id=NULL,
           authority_repository=NULL, authority_revision=NULL,
           graph_fingerprint=NULL, transition_revision_fingerprint=NULL, transition_dependency_fingerprint=NULL,
           expires_at=NULL, hard_expires_at=NULL, active_capability_material=NULL,
           checkpoint=NULL, checkpoint_sha256=NULL, recent_progress_sha256='[]'::jsonb,
           heartbeat_count=0, last_heartbeat_at=NULL,
           continuation=$4::jsonb, continuation_sha256=$5,
           continuation_execution_fingerprint=$6, no_progress_streak=$7, updated_at=$8
         WHERE subject_key=$1 AND lease_ref=$2 AND authority_epoch=$3
         RETURNING *`,
        [input.subject_key,input.lease_ref,input.authority_epoch,JSON.stringify(input.continuation),input.continuation_sha256,input.continuation_execution_fingerprint,input.no_progress_streak,input.updated_at],
      );
      const row = first(result.rows);
      if (!row) return stale(input.subject_key,input.lease_ref,input.authority_epoch);
      return executionFromRow(row);
    },

    async getOperation(command, scope, key) {
      const result = await client.query<Row>(
        'SELECT * FROM operation_state WHERE command=$1 AND idempotency_scope=$2 AND idempotency_key=$3 LIMIT 1',
        [command,scope,key],
      );
      const row = first(result.rows);
      return row ? operationFromRow(row) : null;
    },

    async getOperationById(operationId) {
      const result = await client.query<Row>('SELECT * FROM operation_state WHERE operation_id=$1 LIMIT 1', [operationId]);
      const row = first(result.rows);
      return row ? operationFromRow(row) : null;
    },

    async prepareOperation(input:PrepareOperationInput) {
      requireSha(input.request_sha256, 'request_sha256');
      const inserted = await client.query<Row>(
        `INSERT INTO operation_state (
           operation_id,command,idempotency_scope,idempotency_key,request_sha256,state,subject_key,run_id,
           lease_epoch,authority_revision,may_have_mutated,recovery_payload,created_at
         ) VALUES ($1,$2,$3,$4,$5,'prepared',$6,$7,$8,$9,false,$10::jsonb,$11)
         ON CONFLICT (command,idempotency_scope,idempotency_key) DO NOTHING
         RETURNING *`,
        [input.operation_id,input.command,input.idempotency_scope,input.idempotency_key,input.request_sha256,input.subject_key,input.run_id,input.lease_epoch,input.authority_revision,JSON.stringify(input.recovery_payload),input.created_at],
      );
      const insertedRow = first(inserted.rows);
      if (insertedRow) return operationFromRow(insertedRow);
      const existing = await this.getOperation(input.command,input.idempotency_scope,input.idempotency_key);
      if (!existing) return fail('OPERATION_STATE_UNAVAILABLE', 'operation conflict could not be read back');
      if (existing.request_sha256 !== input.request_sha256) {
        return fail('OPERATION_IDEMPOTENCY_CONFLICT', 'idempotency identity was reused with a different request hash', {
          command:input.command, idempotency_scope:input.idempotency_scope, idempotency_key:input.idempotency_key,
        });
      }
      return existing;
    },

    async markOperationIndeterminate(input:MarkOperationIndeterminateInput) {
      const updated = await client.query<Row>(
        `UPDATE operation_state SET state='indeterminate', may_have_mutated=true, recovery_payload=$2::jsonb
          WHERE operation_id=$1 AND state='prepared' RETURNING *`,
        [input.operation_id,JSON.stringify(input.recovery_payload)],
      );
      const row = first(updated.rows);
      if (row) return operationFromRow(row);
      const existing = await this.getOperationById(input.operation_id);
      if (existing?.state === 'indeterminate') return existing;
      return fail('OPERATION_STATE_CONFLICT', 'operation cannot transition to indeterminate', { operation_id:input.operation_id, state:existing?.state ?? null });
    },

    async resolveOperation(input:ResolveOperationInput) {
      assertTerminalOperationCompactable(input);
      if (input.effect_sha256) requireSha(input.effect_sha256, 'effect_sha256');
      if (input.result_sha256) requireSha(input.result_sha256, 'result_sha256');
      const updated = await client.query<Row>(
        `UPDATE operation_state SET
           state=$2, may_have_mutated=$3, effect_kind=$4, effect_ref=$5, effect_sha256=$6,
           result_sha256=$7, recovery_payload=NULL, resolution=$8::jsonb, resolved_at=$9
         WHERE operation_id=$1 AND state IN ('prepared','indeterminate') RETURNING *`,
        [input.operation_id,input.state,input.may_have_mutated,input.effect_kind,input.effect_ref,input.effect_sha256,input.result_sha256,JSON.stringify(input.resolution),input.resolved_at],
      );
      const row = first(updated.rows);
      if (row) return operationFromRow(row);
      const existing = await this.getOperationById(input.operation_id);
      if (existing && existing.state === input.state
          && existing.may_have_mutated === input.may_have_mutated
          && existing.effect_kind === input.effect_kind
          && existing.effect_ref === input.effect_ref
          && existing.effect_sha256 === input.effect_sha256
          && existing.result_sha256 === input.result_sha256
          && canonicalJson(existing.resolution) === canonicalJson(input.resolution)) return existing;
      return fail('OPERATION_STATE_CONFLICT', 'operation is already resolved differently', { operation_id:input.operation_id, state:existing?.state ?? null });
    },

    async getProof(proofKey) {
      const result = await client.query<Row>('SELECT * FROM proof_state WHERE proof_key=$1 LIMIT 1', [proofKey]);
      const row = first(result.rows);
      return row ? proofFromRow(row) : null;
    },

    async putProof(input:PutProofInput) {
      requireSha(input.evidence_sha256, 'evidence_sha256');
      const inserted = await client.query<Row>(
        `INSERT INTO proof_state (
           proof_key,subject_key,predicate_kind,authority_repository,authority_revision,evidence_sha256,evidence_refs,satisfied_at,consumed_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
         ON CONFLICT (proof_key) DO NOTHING RETURNING *`,
        [input.proof_key,input.subject_key,input.predicate_kind,input.authority_repository,input.authority_revision,input.evidence_sha256,JSON.stringify(input.evidence_refs),input.satisfied_at,input.consumed_at],
      );
      const row = first(inserted.rows);
      if (row) return proofFromRow(row);
      const existing = await this.getProof(input.proof_key);
      if (existing
          && existing.subject_key === input.subject_key
          && existing.predicate_kind === input.predicate_kind
          && existing.authority_repository === input.authority_repository
          && existing.authority_revision === input.authority_revision
          && existing.evidence_sha256 === input.evidence_sha256
          && canonicalJson(existing.evidence_refs) === canonicalJson(input.evidence_refs)) return existing;
      return fail('PROOF_STATE_CONFLICT', 'proof key already names different exact-revision evidence', { proof_key:input.proof_key });
    },

    async deleteProof(proofKey) {
      await client.query('DELETE FROM proof_state WHERE proof_key=$1', [proofKey]);
    },

    async compactRun(input:CompactRunInput) {
      if (input.final_evidence_sha256) requireSha(input.final_evidence_sha256, 'final_evidence_sha256');
      const result = await client.query<Row>(
        `UPDATE orchestration_runs SET
           active_subject_key=$2, unresolved_operation_id=$3,
           final_effect_refs=$4::jsonb, final_evidence_sha256=$5, updated_at=now()
         WHERE run_id=$1 RETURNING run_id`,
        [input.run_id,input.active_subject_key,input.unresolved_operation_id,JSON.stringify(input.final_effect_refs),input.final_evidence_sha256],
      );
      if (!first(result.rows)) fail('RUN_STATE_NOT_FOUND', 'run to compact was not found', { run_id:input.run_id });
    },
  };
}
