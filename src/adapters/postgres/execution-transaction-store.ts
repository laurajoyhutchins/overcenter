import { canonicalJson, sha256Text } from '../../semantic/canonical-json.js';
import {
  assertExecutionIdentity,
  assertExecutionSnapshot,
  assertSettlementReceipt,
  mutationCertaintyFromFacts,
  type ExecutionIdentity,
  type ExecutionLifecycle,
  type ExecutionProof,
  type ExecutionSnapshot,
  type MutationCertainty,
  type ProviderConfirmationFacts,
  type ProviderInvocationFacts,
  type SettlementReceipt,
} from '../../semantic/execution-transaction.js';
import type {
  AppendProofInput,
  ClaimExecutionInput,
  ClaimResult,
  ExecutionTransactionStore,
  HeartbeatExecutionInput,
  OperationAttempt,
  PrepareExecutionInput,
  RecordAttemptInput,
  RecordInvocationInput,
  SettleExecutionInput,
} from '../../ports/execution-transaction-store.js';
import type {
  NodePostgresClient,
  NodePostgresTransactionExecutor,
} from './node-postgres-runtime.js';

type DatabaseRow = Record<string, unknown>;
const OPERATION_COMMAND = 'execution.transaction';

function fail(code: string, message: string, details: unknown = null): never {
  throw Object.assign(new Error(message), { code, details });
}

function firstRow(rows: readonly DatabaseRow[], code: string, message: string): DatabaseRow {
  const row = rows[0];
  if (!row) return fail(code, message);
  return row;
}

function text(value: unknown): string | null {
  return value == null ? null : String(value);
}

function required(value: unknown, field: string): string {
  const result = text(value)?.trim() ?? '';
  if (!result) return fail('EXECUTION_TRANSACTION_ROW_INVALID', `${field} is missing`, { field });
  return result;
}

function integer(value: unknown, field: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(result) || result < 0) {
    return fail('EXECUTION_TRANSACTION_ROW_INVALID', `${field} is invalid`, { field, value });
  }
  return result;
}

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function json(value: unknown): unknown {
  return value == null ? null : value;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function certainty(value: unknown): MutationCertainty {
  if (value === 'definitely_not_mutated' ||
      value === 'may_have_mutated' ||
      value === 'confirmed_mutated') return value;
  return fail('EXECUTION_TRANSACTION_ROW_INVALID', 'mutation certainty is invalid', { value });
}

function lifecycle(value: unknown): ExecutionLifecycle {
  if (value === 'prepared' ||
      value === 'executing' ||
      value === 'effect_uncertain' ||
      value === 'effect_confirmed' ||
      value === 'effect_absent' ||
      value === 'settled' ||
      value === 'rejected' ||
      value === 'escalated') return value;
  return fail('EXECUTION_TRANSACTION_ROW_INVALID', 'execution lifecycle is invalid', { value });
}

function subjectKind(value: unknown): ExecutionIdentity['subject_kind'] {
  if (value === 'project_transition' || value === 'legacy_work' || value === 'provider_operation') return value;
  return fail('EXECUTION_TRANSACTION_ROW_INVALID', 'subject_kind is invalid', { value });
}

function identityFromRow(row: DatabaseRow): ExecutionIdentity {
  const executionId = required(row.execution_id, 'execution_id');
  const identity: ExecutionIdentity = {
    execution_id: executionId,
    operation_id: required(row.operation_id ?? `legacy-operation:${executionId}`, 'operation_id'),
    project_ref: required(row.project_ref, 'project_ref'),
    subject_key: required(row.subject_key, 'subject_key'),
    subject_kind: subjectKind(row.subject_kind),
    run_id: required(row.run_id, 'run_id'),
    lease_ref: required(row.lease_ref, 'lease_ref'),
    lease_epoch: integer(row.lease_epoch, 'lease_epoch'),
    authority_epoch: integer(row.authority_epoch, 'authority_epoch'),
    authority_repository: required(row.authority_repository, 'authority_repository'),
    authority_revision: required(row.authority_revision, 'authority_revision'),
    graph_fingerprint: required(row.graph_fingerprint ?? 'legacy.graph', 'graph_fingerprint'),
    transition_fingerprint: required(
      row.transition_revision_fingerprint ?? 'legacy.transition',
      'transition_fingerprint',
    ),
    operation_kind: required(row.operation_kind ?? 'legacy.execution', 'operation_kind'),
    idempotency_scope: required(row.idempotency_scope ?? 'legacy', 'idempotency_scope'),
    idempotency_key: required(row.idempotency_key ?? executionId, 'idempotency_key'),
    intent_sha256: required(row.intent_sha256 ?? `legacy:${executionId}`, 'intent_sha256'),
  };
  assertExecutionIdentity(identity);
  return identity;
}

async function proofIds(client: NodePostgresClient, executionId: string): Promise<readonly string[]> {
  const result = await client.query<DatabaseRow>(
    'SELECT proof_key FROM proof_state WHERE execution_id = $1 ORDER BY satisfied_at, proof_key',
    [executionId],
  );
  return result.rows.map((row) => required(row.proof_key, 'proof_key'));
}

async function snapshotFromRow(
  client: NodePostgresClient,
  row: DatabaseRow,
): Promise<ExecutionSnapshot> {
  const snapshot: ExecutionSnapshot = {
    identity: identityFromRow(row),
    lifecycle: lifecycle(row.lifecycle),
    attempt_epoch: integer(row.current_attempt_epoch, 'current_attempt_epoch'),
    mutation_certainty: certainty(row.mutation_certainty),
    effect_ref: text(row.effect_ref),
    proof_ids: await proofIds(client, required(row.execution_id, 'execution_id')),
    settled: Boolean(row.settled),
    settlement_receipt: jsonObject(row.settlement_receipt) as SettlementReceipt | null,
  };
  assertExecutionSnapshot(snapshot);
  return snapshot;
}

async function executionById(
  client: NodePostgresClient,
  executionId: string,
  lock = false,
): Promise<DatabaseRow | null> {
  const result = await client.query<DatabaseRow>(
    `SELECT * FROM execution_state WHERE execution_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

async function operationById(
  client: NodePostgresClient,
  operationId: string,
  lock = false,
): Promise<DatabaseRow | null> {
  const result = await client.query<DatabaseRow>(
    `SELECT * FROM operation_state WHERE operation_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [operationId],
  );
  return result.rows[0] ?? null;
}

async function operationByIdempotency(
  client: NodePostgresClient,
  scope: string,
  key: string,
  lock = false,
): Promise<DatabaseRow | null> {
  const result = await client.query<DatabaseRow>(
    `SELECT * FROM operation_state
     WHERE command = $1 AND idempotency_scope = $2 AND idempotency_key = $3${lock ? ' FOR UPDATE' : ''}`,
    [OPERATION_COMMAND, scope, key],
  );
  return result.rows[0] ?? null;
}

function operationAttempt(row: DatabaseRow): OperationAttempt {
  return {
    operation_id: required(row.operation_id, 'operation_id'),
    execution_id: required(row.execution_id, 'execution_id'),
    attempt_epoch: integer(row.attempt_epoch, 'attempt_epoch'),
    request_sha256: required(row.request_sha256, 'request_sha256'),
    mutation_certainty: certainty(row.mutation_certainty),
    effect_ref: text(row.effect_ref),
    response_sha256: text(row.result_sha256),
  };
}

function sameIdentity(row: DatabaseRow, identity: ExecutionIdentity): boolean {
  return text(row.execution_id) === identity.execution_id &&
    text(row.operation_id) === identity.operation_id &&
    text(row.subject_key) === identity.subject_key &&
    text(row.authority_repository) === identity.authority_repository &&
    text(row.authority_revision) === identity.authority_revision &&
    integer(row.authority_epoch, 'authority_epoch') === identity.authority_epoch &&
    text(row.operation_kind ?? row.effect_kind ?? 'legacy.execution') === identity.operation_kind &&
    text(row.idempotency_scope ?? 'legacy') === identity.idempotency_scope &&
    text(row.idempotency_key ?? identity.execution_id) === identity.idempotency_key &&
    text(row.intent_sha256 ?? row.request_sha256 ?? '') === identity.intent_sha256;
}

function requireLease(
  row: DatabaseRow | null,
  identity: ExecutionIdentity,
  attemptEpoch?: number,
): DatabaseRow {
  if (!row) return fail('EXECUTION_NOT_FOUND', 'execution does not exist', { execution_id:identity.execution_id });
  if (!sameIdentity(row, identity) ||
      text(row.run_id) !== identity.run_id ||
      text(row.lease_ref) !== identity.lease_ref ||
      integer(row.lease_epoch, 'lease_epoch') !== identity.lease_epoch ||
      integer(row.authority_epoch, 'authority_epoch') !== identity.authority_epoch) {
    return fail('STALE_EXECUTION', 'execution lease or authority is stale', {
      execution_id:identity.execution_id,
      lease_ref:identity.lease_ref,
      lease_epoch:identity.lease_epoch,
      authority_epoch:identity.authority_epoch,
    });
  }
  if (attemptEpoch !== undefined &&
      integer(row.current_attempt_epoch, 'current_attempt_epoch') !== attemptEpoch) {
    return fail('STALE_ATTEMPT', 'execution attempt is stale', {
      execution_id:identity.execution_id,
      expected:attemptEpoch,
      observed:row.current_attempt_epoch,
    });
  }
  return row;
}

function receiptFromRow(row: DatabaseRow): SettlementReceipt {
  const value = jsonObject(row.settlement_receipt);
  if (!value) return fail('SETTLEMENT_RECEIPT_MISSING', 'settled execution has no receipt');
  const receipt = value as unknown as SettlementReceipt;
  assertSettlementReceipt(receipt);
  return receipt;
}

function responseSha(facts: ProviderInvocationFacts | ProviderConfirmationFacts): string | null {
  return 'transport' in facts ? facts.response_sha256 : null;
}

function effectStateFor(certaintyValue: MutationCertainty): {
  readonly lifecycle: ExecutionLifecycle;
  readonly state: 'succeeded' | 'no_effect' | 'indeterminate';
  readonly may_have_mutated: boolean;
} {
  if (certaintyValue === 'confirmed_mutated') {
    return { lifecycle:'effect_confirmed', state:'succeeded', may_have_mutated:true };
  }
  if (certaintyValue === 'definitely_not_mutated') {
    return { lifecycle:'effect_absent', state:'no_effect', may_have_mutated:false };
  }
  return { lifecycle:'effect_uncertain', state:'indeterminate', may_have_mutated:true };
}

function identityParameters(identity: ExecutionIdentity): readonly unknown[] {
  return [
    identity.execution_id,
    identity.subject_key,
    identity.subject_kind,
    identity.project_ref,
    identity.operation_id,
    identity.run_id,
    identity.lease_ref,
    identity.lease_epoch,
    identity.authority_epoch,
    identity.authority_repository,
    identity.authority_revision,
    identity.graph_fingerprint,
    identity.transition_fingerprint,
    identity.operation_kind,
    identity.idempotency_scope,
    identity.idempotency_key,
    identity.intent_sha256,
  ];
}

export function createPostgresExecutionTransactionStore(
  db: NodePostgresTransactionExecutor,
): ExecutionTransactionStore {
  return {
    async prepareExecution(input: PrepareExecutionInput): Promise<ExecutionSnapshot> {
      assertExecutionIdentity(input.identity);
      return db.transaction(async (client) => {
        const existingOperation = await operationByIdempotency(
          client,
          input.identity.idempotency_scope,
          input.identity.idempotency_key,
          true,
        );
        if (existingOperation) {
          if (!sameIdentity(existingOperation, input.identity) ||
              text(existingOperation.request_sha256) !== input.identity.intent_sha256) {
            return fail('OPERATION_IDEMPOTENCY_CONFLICT', 'idempotency identity was reused with different execution facts');
          }
          const existing = await executionById(client, input.identity.execution_id, true);
          if (!existing) return fail('EXECUTION_NOT_FOUND', 'idempotent operation has no execution row');
          return snapshotFromRow(client, existing);
        }

        const currentResult = await client.query<DatabaseRow>(
          'SELECT * FROM execution_state WHERE subject_key = $1 FOR UPDATE',
          [input.identity.subject_key],
        );
        const current = currentResult.rows[0] ?? null;
        if (current &&
            text(current.execution_id) !== input.identity.execution_id &&
            (text(current.lease_ref) !== null ||
             !['settled', 'rejected', 'escalated'].includes(String(current.lifecycle)))) {
          return fail('EXECUTION_BUSY', 'subject has another active execution', {
            subject_key:input.identity.subject_key,
            execution_id:current.execution_id,
          });
        }

        if (!current) {
          await client.query(
              `INSERT INTO execution_state (
               execution_id, subject_key, subject_kind, project_ref, operation_id,
               lifecycle, lease_ref, lease_epoch, run_id, authority_epoch,
               authority_repository, authority_revision, graph_fingerprint,
               transition_revision_fingerprint, operation_kind, idempotency_scope,
               idempotency_key, intent_sha256, current_attempt_epoch,
               mutation_certainty, settled, expires_at, hard_expires_at
             ) VALUES ($1, $2, $3, $4, $5, 'prepared', $7, $8, $6, $9, $10, $11,
                       $12, $13, $14, $15, $16, $17, 0,
                       'definitely_not_mutated', false,
                       '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')`,
            identityParameters(input.identity),
          );
        } else {
          await client.query(
            `UPDATE execution_state SET
               execution_id = $1,
               subject_kind = $3,
               project_ref = $4,
               operation_id = $5,
               lifecycle = 'prepared',
               lease_ref = $7,
               lease_epoch = $8,
               run_id = $6,
               authority_epoch = $9,
               authority_repository = $10,
               authority_revision = $11,
               graph_fingerprint = $12,
               transition_revision_fingerprint = $13,
               operation_kind = $14,
               idempotency_scope = $15,
               idempotency_key = $16,
               intent_sha256 = $17,
               current_attempt_epoch = 0,
               mutation_certainty = 'definitely_not_mutated',
               effect_ref = NULL,
               settled = false,
               settlement_receipt = NULL,
               settled_at = NULL,
               expires_at = '1970-01-01T00:00:00.000Z',
               hard_expires_at = '1970-01-01T00:00:00.000Z',
               updated_at = now()
             WHERE subject_key = $2`,
            identityParameters(input.identity),
          );
        }

        await client.query(
          `INSERT INTO operation_state (
             operation_id, command, idempotency_scope, idempotency_key,
             request_sha256, state, execution_id, subject_key, run_id,
             lease_epoch, authority_epoch, authority_repository, authority_revision,
             attempt_epoch, may_have_mutated, mutation_certainty, effect_kind
           ) VALUES ($1, $2, $3, $4, $5, 'prepared', $6, $7, $8, $9, $10, $11,
                     $12, 0, false, 'definitely_not_mutated', $13)
           ON CONFLICT (command, idempotency_scope, idempotency_key) DO NOTHING`,
          [
            input.identity.operation_id,
            OPERATION_COMMAND,
            input.identity.idempotency_scope,
            input.identity.idempotency_key,
            input.identity.intent_sha256,
            input.identity.execution_id,
            input.identity.subject_key,
            input.identity.run_id,
            input.identity.lease_epoch,
            input.identity.authority_epoch,
            input.identity.authority_repository,
            input.identity.authority_revision,
            input.identity.operation_kind,
          ],
        );

        const operation = await operationByIdempotency(
          client,
          input.identity.idempotency_scope,
          input.identity.idempotency_key,
          true,
        );
        if (!operation) return fail('OPERATION_NOT_FOUND', 'prepared operation was not persisted');
        if (!sameIdentity(operation, input.identity)) {
          return fail('OPERATION_IDEMPOTENCY_CONFLICT', 'prepared operation identity does not match execution identity');
        }
        const execution = await executionById(client, input.identity.execution_id, true);
        if (!execution) return fail('EXECUTION_NOT_FOUND', 'prepared execution was not persisted');
        return snapshotFromRow(client, execution);
      });
    },

    async claimExecution(input: ClaimExecutionInput): Promise<ClaimResult> {
      return db.transaction(async (client) => {
        const current = await executionById(client, input.execution_id, true);
        if (!current) return fail('EXECUTION_NOT_FOUND', 'execution does not exist', { execution_id:input.execution_id });
        if (integer(current.authority_epoch, 'authority_epoch') !== input.authority_epoch) {
          return fail('STALE_EXECUTION', 'authority epoch has changed');
        }

        const currentLease = text(current.lease_ref);
        const currentLeaseEpoch = integer(current.lease_epoch, 'lease_epoch');
        if (String(current.lifecycle) === 'settled' || Boolean(current.settled)) {
          const snapshot = await snapshotFromRow(client, current);
          return currentLease === input.lease_ref
              && currentLeaseEpoch === input.lease_epoch
              && text(current.run_id) === input.run_id
            ? { kind:'replayed', snapshot }
            : { kind:'busy', snapshot };
        }

        if (String(current.lifecycle) === 'executing' &&
            currentLease === input.lease_ref &&
            currentLeaseEpoch === input.lease_epoch &&
            text(current.run_id) === input.run_id) {
          return { kind:'replayed', snapshot:await snapshotFromRow(client, current) };
        }

        const result = await client.query<DatabaseRow>(
          `UPDATE execution_state SET
             lifecycle = 'executing',
             run_id = $2,
             lease_ref = $3,
             lease_epoch = $4,
             expires_at = $6,
             hard_expires_at = GREATEST(COALESCE(hard_expires_at, $6), $6),
             settled = false,
             settled_at = NULL,
             updated_at = now()
           WHERE execution_id = $1
             AND authority_epoch = $5
             AND lifecycle NOT IN ('settled', 'rejected', 'escalated')
             AND (
               (run_id = $2 AND lease_ref = $3 AND lease_epoch = $4)
               OR expires_at <= now()
             )
           RETURNING *`,
          [
            input.execution_id,
            input.run_id,
            input.lease_ref,
            input.lease_epoch,
            input.authority_epoch,
            input.lease_expires_at,
          ],
        );
        if (result.rows[0]) {
          return { kind:'claimed', snapshot:await snapshotFromRow(client, result.rows[0]!) };
        }
        const observed = await executionById(client, input.execution_id);
        if (!observed) return fail('EXECUTION_NOT_FOUND', 'execution disappeared during claim');
        return { kind:'busy', snapshot:await snapshotFromRow(client, observed) };
      });
    },

    async heartbeatExecution(input: HeartbeatExecutionInput): Promise<ExecutionSnapshot> {
      return db.transaction(async (client) => {
        const current = await executionById(client, input.execution_id, true);
        const identity = current ? identityFromRow(current) : null;
        if (!identity) return fail('EXECUTION_NOT_FOUND', 'execution does not exist');
        requireLease(current, {
          ...identity,
          lease_ref:input.lease_ref,
          lease_epoch:input.lease_epoch,
          authority_epoch:input.authority_epoch,
        });
        const result = await client.query<DatabaseRow>(
          `UPDATE execution_state SET
             expires_at = $6,
             updated_at = now()
           WHERE execution_id = $1
             AND run_id = $2
             AND lease_ref = $3
             AND lease_epoch = $4
             AND authority_epoch = $5
             AND lifecycle IN ('executing', 'effect_uncertain')
           RETURNING *`,
          [
            input.execution_id,
            input.run_id,
            input.lease_ref,
            input.lease_epoch,
            input.authority_epoch,
            input.lease_expires_at,
          ],
        );
        if (!result.rows[0]) return fail('STALE_EXECUTION', 'heartbeat lost its lease fence');
        return snapshotFromRow(client, result.rows[0]!);
      });
    },

    async recordAttempt(input: RecordAttemptInput): Promise<OperationAttempt> {
      assertExecutionIdentity(input.identity);
      return db.transaction(async (client) => {
        const current = await executionById(client, input.identity.execution_id, true);
        requireLease(current, input.identity);
        const currentCertainty = certainty(current?.mutation_certainty);
        if (currentCertainty !== 'definitely_not_mutated' ||
            ['effect_uncertain', 'effect_confirmed', 'effect_absent'].includes(String(current?.lifecycle))) {
          return fail('EFFECT_CONFIRMATION_REQUIRED', 'an effect must be confirmed before another attempt');
        }
        const operation = await operationById(client, input.identity.operation_id, true);
        if (!operation) return fail('OPERATION_NOT_FOUND', 'execution operation does not exist');
        const existingAttempt = integer(operation.attempt_epoch, 'attempt_epoch');
        if (existingAttempt > input.attempt_epoch) {
          return fail('STALE_ATTEMPT', 'attempt epoch is older than the persisted attempt');
        }
        if (existingAttempt === input.attempt_epoch &&
            text(operation.request_sha256) === input.request_sha256 &&
            String(operation.state) === 'prepared') {
          return operationAttempt(operation);
        }
        if (existingAttempt === input.attempt_epoch &&
            text(operation.request_sha256) !== input.request_sha256) {
          return fail('OPERATION_IDEMPOTENCY_CONFLICT', 'attempt request hash changed');
        }
        const result = await client.query<DatabaseRow>(
          `UPDATE operation_state SET
             attempt_epoch = $3,
             request_sha256 = $4,
             state = 'prepared',
             may_have_mutated = false,
             mutation_certainty = 'definitely_not_mutated',
             effect_ref = NULL,
             effect_sha256 = NULL,
             result_sha256 = NULL,
             recovery_payload = NULL,
             resolution = NULL,
             resolved_at = NULL,
             response_facts = NULL,
             confirmation_predicate = NULL,
             confirmed_at = NULL
           WHERE operation_id = $1
             AND execution_id = $2
           RETURNING *`,
          [input.identity.operation_id, input.identity.execution_id, input.attempt_epoch, input.request_sha256],
        );
        if (!result.rows[0]) return fail('STALE_ATTEMPT', 'attempt update lost its execution identity');
        await client.query(
          `UPDATE execution_state SET
             current_attempt_epoch = $2,
             operation_id = $3,
             mutation_certainty = 'definitely_not_mutated',
             effect_ref = NULL,
             lifecycle = 'executing',
             updated_at = now()
           WHERE execution_id = $1
             AND lease_ref = $4
             AND lease_epoch = $5
             AND authority_epoch = $6`,
          [
            input.identity.execution_id,
            input.attempt_epoch,
            input.identity.operation_id,
            input.identity.lease_ref,
            input.identity.lease_epoch,
            input.identity.authority_epoch,
          ],
        );
        return operationAttempt(result.rows[0]!);
      });
    },

    async recordInvocation(input: RecordInvocationInput): Promise<OperationAttempt> {
      assertExecutionIdentity(input.identity);
      const certaintyValue = mutationCertaintyFromFacts(input.facts);
      const effect = effectStateFor(certaintyValue);
      if (certaintyValue === 'confirmed_mutated' && !input.facts.effect_ref) {
        return fail('EFFECT_REFERENCE_REQUIRED', 'confirmed mutation must include a provider effect reference');
      }
      return db.transaction(async (client) => {
        const current = await executionById(client, input.identity.execution_id, true);
        requireLease(current, input.identity, input.attempt_epoch);
        const result = await client.query<DatabaseRow>(
          `UPDATE operation_state SET
             state = $4,
             may_have_mutated = $5,
             mutation_certainty = $6,
             effect_ref = $7,
             result_sha256 = $8,
             response_facts = $9::jsonb,
             confirmation_predicate = NULL,
             confirmed_at = CASE WHEN $6 = 'may_have_mutated' THEN NULL ELSE now() END,
             resolved_at = CASE WHEN $4 = 'indeterminate' THEN NULL ELSE now() END
           WHERE operation_id = $1
             AND execution_id = $2
             AND attempt_epoch = $3
           RETURNING *`,
          [
            input.identity.operation_id,
            input.identity.execution_id,
            input.attempt_epoch,
            effect.state,
            effect.may_have_mutated,
            certaintyValue,
            input.facts.effect_ref,
            responseSha(input.facts),
            JSON.stringify(input.facts),
          ],
        );
        if (!result.rows[0]) return fail('STALE_ATTEMPT', 'invocation facts did not match the current operation');
        await client.query(
          `UPDATE execution_state SET
             lifecycle = $2,
             mutation_certainty = $3,
             effect_ref = $4,
             updated_at = now()
           WHERE execution_id = $1
             AND lease_ref = $5
             AND lease_epoch = $6
             AND authority_epoch = $7
             AND current_attempt_epoch = $8`,
          [
            input.identity.execution_id,
            effect.lifecycle,
            certaintyValue,
            input.facts.effect_ref,
            input.identity.lease_ref,
            input.identity.lease_epoch,
            input.identity.authority_epoch,
            input.attempt_epoch,
          ],
        );
        return operationAttempt(result.rows[0]!);
      });
    },

    async appendProof(input: AppendProofInput): Promise<ExecutionProof> {
      return db.transaction(async (client) => {
        const current = await executionById(client, input.execution_id, true);
        if (!current) return fail('EXECUTION_NOT_FOUND', 'execution does not exist');
        if (text(current.execution_id) !== input.execution_id ||
            text(current.operation_id) !== input.operation_id ||
            integer(current.authority_epoch, 'authority_epoch') !== input.authority_epoch ||
            text(current.authority_repository) !== input.authority_repository ||
            text(current.authority_revision) !== input.authority_revision) {
          return fail('PROOF_IDENTITY_MISMATCH', 'proof does not match the exact execution identity');
        }
        requireLease(current, {
          ...identityFromRow(current),
          run_id: input.run_id,
          lease_ref: input.lease_ref,
          lease_epoch: input.lease_epoch,
        }, input.attempt_epoch);
        let expectedEvidenceSha256: string;
        try {
          expectedEvidenceSha256 = await sha256Text(canonicalJson(input.evidence));
        } catch (error) {
          return fail('PROOF_EVIDENCE_INVALID', 'proof evidence is not canonical JSON', { cause: error });
        }
        if (expectedEvidenceSha256 !== input.evidence_sha256) {
          return fail('PROOF_EVIDENCE_HASH_MISMATCH', 'proof evidence hash does not match canonical evidence', {
            expected: expectedEvidenceSha256,
            observed: input.evidence_sha256,
          });
        }
        await client.query(
          `INSERT INTO proof_state (
             proof_key, subject_key, execution_id, operation_id, attempt_epoch,
             predicate_kind, authority_repository, authority_revision,
             authority_epoch, evidence_sha256, evidence_refs, evidence, satisfied_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, now())
           ON CONFLICT (proof_key) DO NOTHING`,
          [
            input.proof_id,
            required(current.subject_key, 'subject_key'),
            input.execution_id,
            input.operation_id,
            input.attempt_epoch,
            input.predicate,
            input.authority_repository,
            input.authority_revision,
            input.authority_epoch,
            input.evidence_sha256,
            JSON.stringify([{ kind:'evidence_sha256', ref:input.evidence_sha256 }]),
            JSON.stringify(input.evidence),
          ],
        );
        const proof = await client.query<DatabaseRow>(
          `SELECT proof_key, execution_id, operation_id, attempt_epoch,
                  authority_repository, authority_revision, authority_epoch,
                  predicate_kind, evidence_sha256
             FROM proof_state WHERE proof_key = $1 FOR UPDATE`,
          [input.proof_id],
        );
        const row = firstRow(proof.rows, 'PROOF_NOT_FOUND', 'proof was not persisted');
        if (text(row.execution_id) !== input.execution_id ||
            text(row.operation_id) !== input.operation_id ||
            text(row.authority_revision) !== input.authority_revision ||
            text(row.evidence_sha256) !== input.evidence_sha256) {
          return fail('PROOF_IDENTITY_MISMATCH', 'proof key was reused for different execution facts');
        }
        return {
          proof_id:required(row.proof_key, 'proof_id'),
          execution_id:required(row.execution_id, 'execution_id'),
          operation_id:required(row.operation_id, 'operation_id'),
          attempt_epoch:integer(row.attempt_epoch, 'attempt_epoch'),
          authority_repository:required(row.authority_repository, 'authority_repository'),
          authority_revision:required(row.authority_revision, 'authority_revision'),
          authority_epoch:integer(row.authority_epoch, 'authority_epoch'),
          predicate:required(row.predicate_kind, 'predicate'),
          evidence_sha256:required(row.evidence_sha256, 'evidence_sha256'),
        };
      });
    },

    async settleExecution(input: SettleExecutionInput): Promise<SettlementReceipt> {
      assertExecutionIdentity(input.identity);
      return db.transaction(async (client) => {
        const current = await executionById(client, input.identity.execution_id, true);
        if (!current) return fail('EXECUTION_NOT_FOUND', 'execution does not exist');
        if (Boolean(current.settled)) {
          const receipt = receiptFromRow(current);
          if (receipt.execution_id !== input.identity.execution_id
              || receipt.operation_id !== input.identity.operation_id
              || receipt.authority_revision !== input.identity.authority_revision
              || receipt.authority_epoch !== input.identity.authority_epoch
              || receipt.evidence_sha256 !== input.evidence_sha256) {
            return fail('SETTLEMENT_FACT_MISMATCH', 'settlement receipt does not match the exact execution facts');
          }
          return receipt;
        }
        requireLease(current, input.identity, input.attempt_epoch);
        const currentCertainty = certainty(current.mutation_certainty);
        if (currentCertainty === 'may_have_mutated') {
          return fail('EFFECT_UNCERTAIN', 'may_have_mutated execution can only be confirmed or escalated');
        }
        const operation = await operationById(client, input.identity.operation_id, true);
        if (!operation) return fail('OPERATION_NOT_FOUND', 'execution operation does not exist');
        const operationCertainty = certainty(operation.mutation_certainty);
        if (operationCertainty === 'may_have_mutated') {
          return fail('EFFECT_UNCERTAIN', 'operation remains mutation-uncertain');
        }
        if (input.disposition === 'completed' && operationCertainty !== 'confirmed_mutated') {
          return fail('SETTLEMENT_FACT_MISMATCH', 'completed settlement requires confirmed mutation');
        }
        if (input.disposition === 'no_effect' && operationCertainty !== 'definitely_not_mutated') {
          return fail('SETTLEMENT_FACT_MISMATCH', 'no-effect settlement requires definite absence');
        }
        const proof = await client.query<DatabaseRow>(
          `SELECT proof_key FROM proof_state
           WHERE execution_id = $1
             AND operation_id = $2
             AND attempt_epoch = $3
             AND authority_repository = $4
             AND authority_revision = $5
             AND authority_epoch = $6
             AND evidence_sha256 = $7
           FOR UPDATE`,
          [
            input.identity.execution_id,
            input.identity.operation_id,
            input.attempt_epoch,
            input.identity.authority_repository,
            input.identity.authority_revision,
            input.identity.authority_epoch,
            input.evidence_sha256,
          ],
        );
        if (!proof.rows[0]) return fail('PROOF_REQUIRED', 'settlement requires exact structured proof');
        if (input.effect_ref !== null &&
            text(operation.effect_ref) !== input.effect_ref) {
          return fail('SETTLEMENT_FACT_MISMATCH', 'settlement effect reference does not match operation');
        }
        const receipt: SettlementReceipt = {
          schema: 'settlement-receipt-v1',
          execution_id: input.identity.execution_id,
          operation_id: input.identity.operation_id,
          authority_revision: input.identity.authority_revision,
          authority_epoch: input.identity.authority_epoch,
          lifecycle: 'settled',
          disposition: input.disposition,
          effect_ref: input.effect_ref ?? text(operation.effect_ref),
          evidence_sha256: input.evidence_sha256,
        };
        assertSettlementReceipt(receipt);
        const result = await client.query<DatabaseRow>(
          `UPDATE execution_state SET
             lifecycle = 'settled',
             settled = true,
             settled_at = now(),
             settlement_receipt = $2::jsonb,
             effect_ref = $3,
             mutation_certainty = $4,
             updated_at = now()
           WHERE execution_id = $1
             AND lease_ref = $5
             AND lease_epoch = $6
             AND authority_epoch = $7
             AND current_attempt_epoch = $8
           RETURNING *`,
          [
            input.identity.execution_id,
            JSON.stringify(receipt),
            receipt.effect_ref,
            operationCertainty,
            input.identity.lease_ref,
            input.identity.lease_epoch,
            input.identity.authority_epoch,
            input.attempt_epoch,
          ],
        );
        if (!result.rows[0]) return fail('STALE_EXECUTION', 'settlement lost its lease fence');
        return receipt;
      });
    },

    async readExecution(executionId: string): Promise<ExecutionSnapshot | null> {
      const row = await executionById(db, executionId);
      return row ? snapshotFromRow(db, row) : null;
    },
  };
}
