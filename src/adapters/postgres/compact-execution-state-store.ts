import {
  assertExecutionState,
  assertTerminalOperationCompactable,
  type ExecutionState,
  type OperationLifecycleState,
  type OperationState,
  type ProofEvidenceRef,
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
import type {
  NodePostgresClient,
  NodePostgresTransactionExecutor,
} from './node-postgres-runtime.js';

type DatabaseRow = Record<string, unknown>;

function fail(code: string, message: string, details: unknown = null): never {
  throw Object.assign(new Error(message), { code, details });
}

function firstRow(rows: readonly DatabaseRow[], code: string, message: string): DatabaseRow {
  const row = rows[0];
  if (!row) return fail(code, message);
  return row;
}

function nullableText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function requiredText(value: unknown, field: string): string {
  const text = nullableText(value)?.trim() ?? '';
  if (!text) return fail('COMPACT_STATE_ROW_INVALID', `${field} is missing from compact state`, { field });
  return text;
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    return fail('COMPACT_STATE_ROW_INVALID', `${field} is not an integer`, { field, value });
  }
  return parsed;
}

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function jsonValue(value: unknown): unknown | null {
  return value == null ? null : value;
}

function jsonArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  return fail('COMPACT_STATE_ROW_INVALID', 'expected a JSON array', { value });
}

function progressWindow(value: unknown): ExecutionState['recent_progress_sha256'] {
  const values = jsonArray(value).map(String);
  if (values.length === 0) return [];
  if (values.length === 1) return [values[0]!];
  if (values.length === 2) return [values[0]!, values[1]!];
  return fail('COMPACT_STATE_ROW_INVALID', 'progress hash window exceeds two entries', { count:values.length });
}

function executionFromRow(row: DatabaseRow): ExecutionState {
  const state: ExecutionState = {
    subject_key:requiredText(row.subject_key, 'subject_key'),
    subject_kind:requiredText(row.subject_kind, 'subject_kind') as ExecutionState['subject_kind'],
    project_ref:nullableText(row.project_ref),
    transition_id:nullableText(row.transition_id),
    authority_epoch:integer(row.authority_epoch, 'authority_epoch'),
    lease_ref:nullableText(row.lease_ref),
    run_id:nullableText(row.run_id),
    authority_repository:nullableText(row.authority_repository),
    authority_revision:nullableText(row.authority_revision),
    graph_fingerprint:nullableText(row.graph_fingerprint),
    transition_revision_fingerprint:nullableText(row.transition_revision_fingerprint),
    transition_dependency_fingerprint:nullableText(row.transition_dependency_fingerprint),
    expires_at:timestamp(row.expires_at),
    hard_expires_at:timestamp(row.hard_expires_at),
    active_capability_material:nullableText(row.active_capability_material),
    checkpoint:jsonValue(row.checkpoint),
    checkpoint_sha256:nullableText(row.checkpoint_sha256),
    recent_progress_sha256:progressWindow(row.recent_progress_sha256),
    heartbeat_count:integer(row.heartbeat_count, 'heartbeat_count'),
    last_heartbeat_at:timestamp(row.last_heartbeat_at),
    continuation:jsonValue(row.continuation),
    continuation_sha256:nullableText(row.continuation_sha256),
    continuation_execution_fingerprint:nullableText(row.continuation_execution_fingerprint),
    no_progress_streak:integer(row.no_progress_streak, 'no_progress_streak'),
    updated_at:requiredText(timestamp(row.updated_at), 'updated_at'),
  };
  assertExecutionState(state);
  return state;
}

function operationFromRow(row: DatabaseRow): OperationState {
  const state = requiredText(row.state, 'state') as OperationLifecycleState;
  if (!['prepared', 'indeterminate', 'succeeded', 'no_effect', 'rejected'].includes(state)) {
    return fail('COMPACT_STATE_ROW_INVALID', 'operation state is invalid', { state });
  }
  return {
    operation_id:requiredText(row.operation_id, 'operation_id'),
    command:requiredText(row.command, 'command'),
    idempotency_scope:requiredText(row.idempotency_scope, 'idempotency_scope'),
    idempotency_key:requiredText(row.idempotency_key, 'idempotency_key'),
    request_sha256:requiredText(row.request_sha256, 'request_sha256'),
    state,
    subject_key:nullableText(row.subject_key),
    run_id:nullableText(row.run_id),
    lease_epoch:row.lease_epoch == null ? null : integer(row.lease_epoch, 'lease_epoch'),
    authority_revision:nullableText(row.authority_revision),
    may_have_mutated:Boolean(row.may_have_mutated),
    effect_kind:nullableText(row.effect_kind),
    effect_ref:nullableText(row.effect_ref),
    effect_sha256:nullableText(row.effect_sha256),
    result_sha256:nullableText(row.result_sha256),
    recovery_payload:jsonValue(row.recovery_payload),
    resolution:jsonValue(row.resolution),
    created_at:requiredText(timestamp(row.created_at), 'created_at'),
    resolved_at:timestamp(row.resolved_at),
  };
}

function proofFromRow(row: DatabaseRow): ProofState {
  const refs = jsonArray(row.evidence_refs).map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return fail('COMPACT_STATE_ROW_INVALID', 'proof evidence ref is invalid', { value });
    }
    const ref = value as Record<string, unknown>;
    return {
      kind:requiredText(ref.kind, 'evidence_refs.kind'),
      ref:requiredText(ref.ref, 'evidence_refs.ref'),
    } satisfies ProofEvidenceRef;
  });
  return {
    proof_key:requiredText(row.proof_key, 'proof_key'),
    subject_key:requiredText(row.subject_key, 'subject_key'),
    predicate_kind:requiredText(row.predicate_kind, 'predicate_kind'),
    authority_repository:requiredText(row.authority_repository, 'authority_repository'),
    authority_revision:requiredText(row.authority_revision, 'authority_revision'),
    evidence_sha256:requiredText(row.evidence_sha256, 'evidence_sha256'),
    evidence_refs:refs,
    satisfied_at:requiredText(timestamp(row.satisfied_at), 'satisfied_at'),
    consumed_at:timestamp(row.consumed_at),
  };
}

async function executionBySubject(client: NodePostgresClient, subjectKey: string, lock = false): Promise<ExecutionState | null> {
  const result = await client.query<DatabaseRow>(
    `SELECT * FROM execution_state WHERE subject_key = $1${lock ? ' FOR UPDATE' : ''}`,
    [subjectKey],
  );
  return result.rows[0] ? executionFromRow(result.rows[0]) : null;
}

async function operationById(client: NodePostgresClient, operationId: string): Promise<OperationState | null> {
  const result = await client.query<DatabaseRow>('SELECT * FROM operation_state WHERE operation_id = $1', [operationId]);
  return result.rows[0] ? operationFromRow(result.rows[0]) : null;
}

function requireFence(current: ExecutionState | null, leaseRef: string, authorityEpoch: number): ExecutionState {
  if (!current || current.lease_ref !== leaseRef || current.authority_epoch !== authorityEpoch) {
    return fail('EXECUTION_AUTHORITY_STALE', 'execution authority no longer matches the current compact state', {
      expected:{ lease_ref:leaseRef, authority_epoch:authorityEpoch },
      observed:current ? { lease_ref:current.lease_ref, authority_epoch:current.authority_epoch } : null,
    });
  }
  return current;
}

function equivalentResolution(existing: OperationState, input: ResolveOperationInput): boolean {
  return existing.state === input.state
    && existing.may_have_mutated === input.may_have_mutated
    && existing.effect_kind === input.effect_kind
    && existing.effect_ref === input.effect_ref
    && existing.effect_sha256 === input.effect_sha256
    && existing.result_sha256 === input.result_sha256;
}

function equivalentProofIdentity(existing: ProofState, input: PutProofInput): boolean {
  return existing.subject_key === input.subject_key
    && existing.predicate_kind === input.predicate_kind
    && existing.authority_repository === input.authority_repository
    && existing.authority_revision === input.authority_revision
    && existing.evidence_sha256 === input.evidence_sha256
    && JSON.stringify(existing.evidence_refs) === JSON.stringify(input.evidence_refs)
    && existing.satisfied_at === input.satisfied_at;
}

export function createPostgresCompactExecutionStateStore(
  db: NodePostgresTransactionExecutor,
): CompactExecutionStateStore {
  return {
    async getExecution(subjectKey) {
      return executionBySubject(db, subjectKey);
    },

    async acquireExecution(input: AcquireExecutionInput) {
      return db.transaction(async (client) => {
        await client.query(
          `INSERT INTO execution_state (subject_key, subject_kind, authority_epoch, updated_at)
           VALUES ($1, $2, 0, now())
           ON CONFLICT (subject_key) DO NOTHING`,
          [input.subject_key, input.subject_kind],
        );
        const current = await executionBySubject(client, input.subject_key, true);
        if (!current) return fail('EXECUTION_STATE_NOT_FOUND', 'execution state disappeared during acquisition');
        if (current.subject_kind !== input.subject_kind) {
          return fail('EXECUTION_SUBJECT_KIND_CONFLICT', 'execution subject kind cannot change', {
            subject_key:input.subject_key,
            existing:current.subject_kind,
            requested:input.subject_kind,
          });
        }
        if (current.lease_ref !== null) {
          return fail('EXECUTION_AUTHORITY_BUSY', 'execution subject already has active authority', {
            subject_key:input.subject_key,
            lease_ref:current.lease_ref,
            authority_epoch:current.authority_epoch,
          });
        }
        const nextEpoch = current.authority_epoch + 1;
        const result = await client.query<DatabaseRow>(
          `UPDATE execution_state SET
             project_ref = $2,
             transition_id = $3,
             authority_epoch = $4,
             lease_ref = $5,
             run_id = $6,
             authority_repository = $7,
             authority_revision = $8,
             graph_fingerprint = $9,
             transition_revision_fingerprint = $10,
             transition_dependency_fingerprint = $11,
             expires_at = $12,
             hard_expires_at = $13,
             active_capability_material = $14,
             checkpoint = NULL,
             checkpoint_sha256 = NULL,
             recent_progress_sha256 = '[]'::jsonb,
             heartbeat_count = 0,
             last_heartbeat_at = NULL,
             updated_at = now()
           WHERE subject_key = $1
           RETURNING *`,
          [
            input.subject_key,
            input.project_ref ?? null,
            input.transition_id ?? null,
            nextEpoch,
            input.lease_ref,
            input.run_id,
            input.authority_repository,
            input.authority_revision,
            input.graph_fingerprint ?? null,
            input.transition_revision_fingerprint ?? null,
            input.transition_dependency_fingerprint ?? null,
            input.expires_at,
            input.hard_expires_at,
            input.active_capability_material ?? null,
          ],
        );
        return executionFromRow(firstRow(result.rows, 'EXECUTION_STATE_NOT_FOUND', 'execution acquisition did not return state'));
      });
    },

    async writeCheckpoint(input: WriteCheckpointInput) {
      const result = await db.query<DatabaseRow>(
        `UPDATE execution_state SET
           checkpoint = $4::jsonb,
           checkpoint_sha256 = $5,
           updated_at = $6
         WHERE subject_key = $1 AND lease_ref = $2 AND authority_epoch = $3
         RETURNING *`,
        [
          input.subject_key,
          input.lease_ref,
          input.authority_epoch,
          JSON.stringify(input.checkpoint),
          input.checkpoint_sha256,
          input.updated_at,
        ],
      );
      if (!result.rows[0]) return fail('EXECUTION_AUTHORITY_STALE', 'checkpoint write used stale execution authority');
      return executionFromRow(result.rows[0]);
    },

    async heartbeatExecution(input: HeartbeatExecutionInput) {
      return db.transaction(async (client) => {
        const current = requireFence(
          await executionBySubject(client, input.subject_key, true),
          input.lease_ref,
          input.authority_epoch,
        );
        const recent = [...current.recent_progress_sha256, input.progress_sha256].slice(-2);
        const result = await client.query<DatabaseRow>(
          `UPDATE execution_state SET
             recent_progress_sha256 = $4::jsonb,
             heartbeat_count = heartbeat_count + 1,
             expires_at = $5,
             last_heartbeat_at = $6,
             updated_at = $6
           WHERE subject_key = $1 AND lease_ref = $2 AND authority_epoch = $3
           RETURNING *`,
          [
            input.subject_key,
            input.lease_ref,
            input.authority_epoch,
            JSON.stringify(recent),
            input.expires_at,
            input.heartbeat_at,
          ],
        );
        if (!result.rows[0]) return fail('EXECUTION_AUTHORITY_STALE', 'heartbeat used stale execution authority');
        return executionFromRow(result.rows[0]);
      });
    },

    async settleExecution(input: SettleExecutionInput) {
      return db.transaction(async (client) => {
        requireFence(
          await executionBySubject(client, input.subject_key, true),
          input.lease_ref,
          input.authority_epoch,
        );
        const result = await client.query<DatabaseRow>(
          `UPDATE execution_state SET
             lease_ref = NULL,
             run_id = NULL,
             authority_repository = NULL,
             authority_revision = NULL,
             graph_fingerprint = NULL,
             transition_revision_fingerprint = NULL,
             transition_dependency_fingerprint = NULL,
             expires_at = NULL,
             hard_expires_at = NULL,
             active_capability_material = NULL,
             checkpoint = NULL,
             checkpoint_sha256 = NULL,
             recent_progress_sha256 = '[]'::jsonb,
             heartbeat_count = 0,
             last_heartbeat_at = NULL,
             continuation = $4::jsonb,
             continuation_sha256 = $5,
             continuation_execution_fingerprint = $6,
             no_progress_streak = $7,
             updated_at = $8
           WHERE subject_key = $1 AND lease_ref = $2 AND authority_epoch = $3
           RETURNING *`,
          [
            input.subject_key,
            input.lease_ref,
            input.authority_epoch,
            input.continuation == null ? null : JSON.stringify(input.continuation),
            input.continuation_sha256,
            input.continuation_execution_fingerprint,
            input.no_progress_streak,
            input.updated_at,
          ],
        );
        if (!result.rows[0]) return fail('EXECUTION_AUTHORITY_STALE', 'settlement used stale execution authority');
        return executionFromRow(result.rows[0]);
      });
    },

    async getOperation(command, scope, key) {
      const result = await db.query<DatabaseRow>(
        `SELECT * FROM operation_state
         WHERE command = $1 AND idempotency_scope = $2 AND idempotency_key = $3`,
        [command, scope, key],
      );
      return result.rows[0] ? operationFromRow(result.rows[0]) : null;
    },

    async getOperationById(operationId) {
      return operationById(db, operationId);
    },

    async prepareOperation(input: PrepareOperationInput) {
      return db.transaction(async (client) => {
        await client.query(
          `INSERT INTO operation_state (
             operation_id, command, idempotency_scope, idempotency_key, request_sha256,
             state, subject_key, run_id, lease_epoch, authority_revision,
             may_have_mutated, created_at
           ) VALUES ($1, $2, $3, $4, $5, 'prepared', $6, $7, $8, $9, false, $10)
           ON CONFLICT (command, idempotency_scope, idempotency_key) DO NOTHING`,
          [
            input.operation_id,
            input.command,
            input.idempotency_scope,
            input.idempotency_key,
            input.request_sha256,
            input.subject_key ?? null,
            input.run_id ?? null,
            input.lease_epoch ?? null,
            input.authority_revision ?? null,
            input.created_at,
          ],
        );
        const result = await client.query<DatabaseRow>(
          `SELECT * FROM operation_state
           WHERE command = $1 AND idempotency_scope = $2 AND idempotency_key = $3
           FOR UPDATE`,
          [input.command, input.idempotency_scope, input.idempotency_key],
        );
        const existing = operationFromRow(firstRow(
          result.rows,
          'OPERATION_STATE_NOT_FOUND',
          'operation state disappeared during idempotent preparation',
        ));
        if (existing.request_sha256 !== input.request_sha256) {
          return fail('OPERATION_IDEMPOTENCY_CONFLICT', 'idempotency key was reused with a different request', {
            command:input.command,
            idempotency_scope:input.idempotency_scope,
            idempotency_key:input.idempotency_key,
            existing_request_sha256:existing.request_sha256,
            requested_request_sha256:input.request_sha256,
          });
        }
        return existing;
      });
    },

    async markOperationIndeterminate(input: MarkOperationIndeterminateInput) {
      const result = await db.query<DatabaseRow>(
        `UPDATE operation_state SET
           state = 'indeterminate',
           may_have_mutated = true,
           recovery_payload = $2::jsonb,
           effect_kind = $3,
           effect_ref = $4,
           effect_sha256 = $5,
           resolution = NULL,
           resolved_at = NULL
         WHERE operation_id = $1 AND state IN ('prepared', 'indeterminate')
         RETURNING *`,
        [
          input.operation_id,
          JSON.stringify(input.recovery_payload),
          input.effect_kind,
          input.effect_ref,
          input.effect_sha256,
        ],
      );
      if (result.rows[0]) return operationFromRow(result.rows[0]);
      const existing = await operationById(db, input.operation_id);
      if (!existing) return fail('OPERATION_STATE_NOT_FOUND', 'operation does not exist');
      return fail('OPERATION_ALREADY_RESOLVED', 'terminal operation cannot become indeterminate', {
        operation_id:input.operation_id,
        state:existing.state,
      });
    },

    async resolveOperation(input: ResolveOperationInput) {
      if ((input.state === 'no_effect' || input.state === 'rejected') && input.may_have_mutated) {
        return fail('OPERATION_STATE_INVALID', `${input.state} cannot retain mutation uncertainty`);
      }
      assertTerminalOperationCompactable({
        state:input.state,
        may_have_mutated:input.may_have_mutated,
        effect_ref:input.effect_ref,
      });
      const result = await db.query<DatabaseRow>(
        `UPDATE operation_state SET
           state = $2,
           may_have_mutated = $3,
           effect_kind = $4,
           effect_ref = $5,
           effect_sha256 = $6,
           result_sha256 = $7,
           recovery_payload = NULL,
           resolution = $8::jsonb,
           resolved_at = $9
         WHERE operation_id = $1 AND state IN ('prepared', 'indeterminate')
         RETURNING *`,
        [
          input.operation_id,
          input.state,
          input.may_have_mutated,
          input.effect_kind,
          input.effect_ref,
          input.effect_sha256,
          input.result_sha256,
          input.resolution == null ? null : JSON.stringify(input.resolution),
          input.resolved_at,
        ],
      );
      if (result.rows[0]) return operationFromRow(result.rows[0]);
      const existing = await operationById(db, input.operation_id);
      if (!existing) return fail('OPERATION_STATE_NOT_FOUND', 'operation does not exist');
      if (equivalentResolution(existing, input)) return existing;
      return fail('OPERATION_ALREADY_RESOLVED', 'operation is already resolved differently', {
        operation_id:input.operation_id,
        state:existing.state,
      });
    },

    async getProof(proofKey) {
      const result = await db.query<DatabaseRow>('SELECT * FROM proof_state WHERE proof_key = $1', [proofKey]);
      return result.rows[0] ? proofFromRow(result.rows[0]) : null;
    },

    async putProof(input: PutProofInput) {
      return db.transaction(async (client) => {
        await client.query(
          `INSERT INTO proof_state (
             proof_key, subject_key, predicate_kind, authority_repository, authority_revision,
             evidence_sha256, evidence_refs, satisfied_at, consumed_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           ON CONFLICT (proof_key) DO NOTHING`,
          [
            input.proof_key,
            input.subject_key,
            input.predicate_kind,
            input.authority_repository,
            input.authority_revision,
            input.evidence_sha256,
            JSON.stringify(input.evidence_refs),
            input.satisfied_at,
            input.consumed_at,
          ],
        );
        const result = await client.query<DatabaseRow>(
          'SELECT * FROM proof_state WHERE proof_key = $1 FOR UPDATE',
          [input.proof_key],
        );
        const existing = proofFromRow(firstRow(
          result.rows,
          'PROOF_STATE_NOT_FOUND',
          'proof state disappeared during idempotent write',
        ));
        if (!equivalentProofIdentity(existing, input)) {
          return fail('PROOF_IDENTITY_CONFLICT', 'proof key cannot be rebound to different authority or evidence', {
            proof_key:input.proof_key,
            existing_authority_repository:existing.authority_repository,
            existing_authority_revision:existing.authority_revision,
            requested_authority_repository:input.authority_repository,
            requested_authority_revision:input.authority_revision,
          });
        }
        if (existing.consumed_at === input.consumed_at) return existing;
        if (existing.consumed_at !== null || input.consumed_at === null) {
          return fail('PROOF_CONSUMPTION_CONFLICT', 'proof consumption cannot be reversed or rewritten', {
            proof_key:input.proof_key,
            existing_consumed_at:existing.consumed_at,
            requested_consumed_at:input.consumed_at,
          });
        }
        const consumed = await client.query<DatabaseRow>(
          `UPDATE proof_state
              SET consumed_at = $2
            WHERE proof_key = $1 AND consumed_at IS NULL
            RETURNING *`,
          [input.proof_key, input.consumed_at],
        );
        return proofFromRow(firstRow(
          consumed.rows,
          'PROOF_CONSUMPTION_CONFLICT',
          'proof consumption lost its exact identity fence',
        ));
      });
    },

    async deleteProof(proofKey) {
      await db.query('DELETE FROM proof_state WHERE proof_key = $1', [proofKey]);
    },

    async compactRun(input: CompactRunInput) {
      const result = await db.query<DatabaseRow>(
        `UPDATE orchestration_runs SET
           active_subject_key = $2,
           unresolved_operation_id = $3,
           final_effect_refs = $4::jsonb,
           final_evidence_sha256 = $5,
           updated_at = now()
         WHERE run_id = $1
         RETURNING run_id`,
        [
          input.run_id,
          input.active_subject_key,
          input.unresolved_operation_id,
          JSON.stringify(input.final_effect_refs),
          input.final_evidence_sha256,
        ],
      );
      if (!result.rows[0]) return fail('ORCHESTRATION_RUN_NOT_FOUND', 'run does not exist', { run_id:input.run_id });
    },
  };
}
