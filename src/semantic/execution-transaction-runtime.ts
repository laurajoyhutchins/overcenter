import { canonicalJson, sha256Text } from './canonical-json.js';
import {
  classifyRecovery,
  mutationCertaintyFromFacts,
  type ExecutionIdentity,
  type ExecutionIntent,
  type ExecutionSnapshot,
  type JsonObject,
  type MutationCertainty,
  type ProviderConfirmationFacts,
  type ProviderEffect,
  type ProviderInvocationFacts,
  type SettlementReceipt,
} from './execution-transaction.js';
import type { JsonValue } from './project-graph-types.js';
import type {
  ExecutionTransactionStore,
  RecordInvocationInput,
} from './execution-transaction-store.js';

export interface ExecutionTransactionContext {
  readonly run_id: string;
  readonly subject_kind: 'project_transition' | 'legacy_work' | 'provider_operation';
  readonly lease_expires_at: string;
  readonly lease_ref?: string;
  readonly lease_epoch?: number;
  readonly authority_epoch?: number;
}

export interface ExecutionTransactionResult {
  readonly receipt: SettlementReceipt;
  readonly snapshot: ExecutionSnapshot | null;
  readonly identity: ExecutionIdentity;
}

function fail(code: string, message: string, details: unknown = null): never {
  throw Object.assign(new Error(message), { code, details });
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return fail('EXECUTION_INTENT_INVALID', `${field} is required`, { field });
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    return fail('EXECUTION_INTENT_INVALID', `${field} must be a non-negative integer`, { field, value });
  }
  return Number(value);
}

function uuidFromHash(hash: string): string {
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

async function identityFor<TPayload extends JsonValue>(
  intent: ExecutionIntent<TPayload>,
  context: ExecutionTransactionContext,
): Promise<ExecutionIdentity> {
  const intent_sha256 = await sha256Text(canonicalJson(intent));
  const operationHash = await sha256Text(`operation:${intent_sha256}`);
  const executionHash = await sha256Text(`execution:${intent_sha256}`);
  const leaseHash = await sha256Text(`lease:${intent_sha256}:${context.run_id}`);
  const lease_epoch = context.lease_epoch ?? 1;
  const lease_ref = context.lease_ref ?? uuidFromHash(leaseHash);

  return {
    execution_id: `execution:${executionHash}`,
    operation_id: uuidFromHash(operationHash),
    project_ref: requiredText(intent.project_ref, 'project_ref'),
    subject_key: requiredText(intent.subject_key, 'subject_key'),
    subject_kind: context.subject_kind,
    run_id: requiredText(context.run_id, 'run_id'),
    lease_ref: requiredText(lease_ref, 'lease_ref'),
    lease_epoch: positiveInteger(lease_epoch, 'lease_epoch'),
    authority_epoch: positiveInteger(intent.authority.epoch, 'authority_epoch'),
    authority_repository: requiredText(intent.authority.repository, 'authority.repository'),
    authority_revision: requiredText(intent.authority.revision, 'authority.revision'),
    graph_fingerprint: requiredText(intent.authority.graph_fingerprint, 'authority.graph_fingerprint'),
    transition_fingerprint: requiredText(
      intent.authority.transition_fingerprint,
      'authority.transition_fingerprint',
    ),
    operation_kind: requiredText(intent.operation.kind, 'operation.kind'),
    idempotency_scope: requiredText(
      intent.operation.idempotency_scope,
      'operation.idempotency_scope',
    ),
    idempotency_key: requiredText(
      intent.operation.idempotency_key,
      'operation.idempotency_key',
    ),
    intent_sha256,
  };
}

function responseSha(facts: ProviderInvocationFacts | ProviderConfirmationFacts): string | null {
  return 'transport' in facts ? facts.response_sha256 : null;
}

function evidenceFor(facts: ProviderInvocationFacts | ProviderConfirmationFacts): JsonObject {
  if (facts.evidence) return facts.evidence;
  if ('transport' in facts) {
    return {
      transport: facts.transport,
      committed: facts.committed,
      effect_ref: facts.effect_ref,
      response_sha256: facts.response_sha256,
    };
  }
  return {
    status: facts.status,
    effect_ref: facts.effect_ref,
    predicate: facts.predicate,
  };
}

function predicateFor(facts: ProviderInvocationFacts | ProviderConfirmationFacts): string {
  return 'status' in facts ? facts.predicate : 'provider-invocation';
}

function unknownInvocation(error: unknown): ProviderInvocationFacts {
  return {
    transport: 'unknown',
    committed: null,
    effect_ref: null,
    response_sha256: null,
    evidence: {
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

function unknownConfirmation(error: unknown): ProviderConfirmationFacts {
  return {
    status: 'unknown',
    effect_ref: null,
    predicate: 'provider-readback',
    evidence: {
      error: error instanceof Error ? error.message : String(error),
    },
  };
}

async function requestHash<TPayload extends JsonValue>(
  intent: ExecutionIntent<TPayload>,
  identity: ExecutionIdentity,
  attempt_epoch: number,
): Promise<string> {
  return sha256Text(canonicalJson({
    intent,
    execution_id: identity.execution_id,
    operation_id: identity.operation_id,
    run_id: identity.run_id,
    attempt_epoch,
  }));
}

async function appendProofAndSettle<TPayload extends JsonValue>(
  store: ExecutionTransactionStore,
  intent: ExecutionIntent<TPayload>,
  identity: ExecutionIdentity,
  attempt_epoch: number,
  facts: ProviderInvocationFacts | ProviderConfirmationFacts,
  disposition: SettlementReceipt['disposition'],
): Promise<ExecutionTransactionResult> {
  const certainty: MutationCertainty = mutationCertaintyFromFacts(facts);
  if (certainty === 'may_have_mutated') {
    return fail('EXECUTION_ESCALATED', 'effect remains mutation-uncertain', {
      execution_id: identity.execution_id,
      attempt_epoch,
    });
  }

  if (certainty === 'confirmed_mutated' && !facts.effect_ref) {
    return fail('EFFECT_REFERENCE_REQUIRED', 'confirmed mutation must include a provider effect reference', {
      execution_id: identity.execution_id,
      attempt_epoch,
    });
  }

  const providerEvidence = evidenceFor(facts);
  const evidence: JsonObject = {
    schema: 'execution-proof-evidence-v1',
    execution_id: identity.execution_id,
    operation_id: identity.operation_id,
    attempt_epoch,
    authority: {
      repository: identity.authority_repository,
      revision: identity.authority_revision,
      epoch: identity.authority_epoch,
    },
    predicate: predicateFor(facts),
    evidence: providerEvidence,
  };
  const evidence_sha256 = await sha256Text(canonicalJson(evidence));
  const proof_id = `proof:${identity.execution_id}:${attempt_epoch}:${evidence_sha256}`;
  await store.appendProof({
    proof_id,
    execution_id: identity.execution_id,
    operation_id: identity.operation_id,
    run_id: identity.run_id,
    lease_ref: identity.lease_ref,
    lease_epoch: identity.lease_epoch,
    attempt_epoch,
    authority_repository: identity.authority_repository,
    authority_revision: identity.authority_revision,
    authority_epoch: identity.authority_epoch,
    predicate: predicateFor(facts),
    evidence_sha256,
    evidence,
  });

  const receipt = await store.settleExecution({
    identity,
    attempt_epoch,
    disposition,
    effect_ref: facts.effect_ref,
    evidence_sha256,
  });
  return {
    receipt,
    snapshot: await store.readExecution(identity.execution_id),
    identity,
  };
}

async function confirmAndSettle<TPayload extends JsonValue>(
  store: ExecutionTransactionStore,
  provider: ProviderEffect<TPayload>,
  intent: ExecutionIntent<TPayload>,
  identity: ExecutionIdentity,
  attempt_epoch: number,
): Promise<ExecutionTransactionResult> {
  let confirmation: ProviderConfirmationFacts;
  try {
    confirmation = await provider.confirm({
      intent,
      identity,
      attempt_epoch,
      effect_ref: null,
    });
  } catch (error) {
    confirmation = unknownConfirmation(error);
  }
  await store.recordInvocation({
    identity,
    attempt_epoch,
    facts: confirmation,
  } satisfies RecordInvocationInput);
  if (confirmation.status === 'unknown') {
    return fail('EXECUTION_ESCALATED', 'provider readback could not prove the effect outcome', {
      execution_id: identity.execution_id,
      attempt_epoch,
    });
  }
  return appendProofAndSettle(
    store,
    intent,
    identity,
    attempt_epoch,
    confirmation,
    confirmation.status === 'confirmed' ? 'completed' : 'no_effect',
  );
}

async function executeClaimed<TPayload extends JsonValue>(
  store: ExecutionTransactionStore,
  provider: ProviderEffect<TPayload>,
  intent: ExecutionIntent<TPayload>,
  identity: ExecutionIdentity,
  context: ExecutionTransactionContext,
): Promise<ExecutionTransactionResult> {
  const preflight = await provider.preflight({ intent, identity });
  if (preflight.observed_revision !== identity.authority_revision) {
    const attempt_epoch = 1;
    await store.recordAttempt({
      identity,
      attempt_epoch,
      request_sha256: await requestHash(intent, identity, attempt_epoch),
    });
    const rejected: ProviderInvocationFacts = {
      transport: 'rejected',
      committed: false,
      effect_ref: null,
      response_sha256: null,
      evidence: {
        reason: 'authority_revision_mismatch',
        expected_revision: identity.authority_revision,
        observed_revision: preflight.observed_revision,
        provider: preflight.provider,
      },
    };
    await store.recordInvocation({ identity, attempt_epoch, facts: rejected });
    return appendProofAndSettle(store, intent, identity, attempt_epoch, rejected, 'rejected');
  }

  const attempt_epoch = 1;
  await store.recordAttempt({
    identity,
    attempt_epoch,
    request_sha256: await requestHash(intent, identity, attempt_epoch),
  });

  let invocation: ProviderInvocationFacts;
  try {
    invocation = await provider.invoke({ intent, identity, attempt_epoch });
  } catch (error) {
    invocation = unknownInvocation(error);
  }

  await store.recordInvocation({ identity, attempt_epoch, facts: invocation });
  const invocationCertainty = mutationCertaintyFromFacts(invocation);
  if (invocationCertainty === 'may_have_mutated') {
    return confirmAndSettle(store, provider, intent, identity, attempt_epoch);
  }
  return appendProofAndSettle(
    store,
    intent,
    identity,
    attempt_epoch,
    invocation,
    invocationCertainty === 'confirmed_mutated' ? 'completed' : 'no_effect',
  );
}

export async function executeExecutionTransaction<TPayload extends JsonValue>(
  input: {
    readonly intent: ExecutionIntent<TPayload>;
    readonly context: ExecutionTransactionContext;
    readonly provider: ProviderEffect<TPayload>;
    readonly store: ExecutionTransactionStore;
  },
): Promise<ExecutionTransactionResult> {
  const identity = await identityFor(input.intent, input.context);
  const prepared = await input.store.prepareExecution({ identity, lifecycle: 'prepared' });
  if (prepared.settlement_receipt) {
    return { receipt: prepared.settlement_receipt, snapshot: prepared, identity: prepared.identity };
  }

  const claim = await input.store.claimExecution({
    execution_id: identity.execution_id,
    run_id: input.context.run_id,
    lease_ref: identity.lease_ref,
    lease_epoch: identity.lease_epoch,
    authority_epoch: input.context.authority_epoch ?? identity.authority_epoch,
    lease_expires_at: input.context.lease_expires_at,
  });
  if (claim.kind === 'busy') {
    return fail('EXECUTION_BUSY', 'execution is owned by another worker', {
      execution_id: identity.execution_id,
    });
  }
  const claimedIdentity: ExecutionIdentity = {
    ...identity,
    lease_ref: claim.snapshot.identity.lease_ref,
    lease_epoch: claim.snapshot.identity.lease_epoch,
  };
  if (claim.snapshot.settlement_receipt) {
    return {
      receipt: claim.snapshot.settlement_receipt,
      snapshot: claim.snapshot,
      identity: claimedIdentity,
    };
  }
  if (claim.snapshot.attempt_epoch > 0) {
    return recoverExecutionTransaction({
      execution_id: identity.execution_id,
      intent: input.intent,
      context: input.context,
      provider: input.provider,
      store: input.store,
    });
  }
  return executeClaimed(input.store, input.provider, input.intent, claimedIdentity, input.context);
}

export async function recoverExecutionTransaction<TPayload extends JsonValue>(
  input: {
    readonly execution_id: string;
    readonly intent: ExecutionIntent<TPayload>;
    readonly context: ExecutionTransactionContext;
    readonly provider: ProviderEffect<TPayload>;
    readonly store: ExecutionTransactionStore;
  },
): Promise<ExecutionTransactionResult> {
  const snapshot = await input.store.readExecution(input.execution_id);
  if (!snapshot) return fail('EXECUTION_NOT_FOUND', 'execution cannot be recovered');
  const intentHash = await sha256Text(canonicalJson(input.intent));
  if (snapshot.identity.intent_sha256 !== intentHash) {
    return fail('EXECUTION_INTENT_MISMATCH', 'recovery intent does not match durable execution identity');
  }
  if (snapshot.settlement_receipt) {
    return {
      receipt: snapshot.settlement_receipt,
      snapshot,
      identity: snapshot.identity,
    };
  }

  const lease_ref = input.context.lease_ref ?? snapshot.identity.lease_ref;
  const lease_epoch = input.context.lease_epoch ?? snapshot.identity.lease_epoch;
  const identity: ExecutionIdentity = { ...snapshot.identity, lease_ref, lease_epoch };
  const claim = await input.store.claimExecution({
    execution_id: input.execution_id,
    run_id: input.context.run_id,
    lease_ref,
    lease_epoch,
    authority_epoch: input.context.authority_epoch ?? identity.authority_epoch,
    lease_expires_at: input.context.lease_expires_at,
  });
  if (claim.kind === 'busy') {
    return fail('EXECUTION_BUSY', 'replacement worker could not claim execution');
  }
  const claimedIdentity: ExecutionIdentity = {
    ...identity,
    lease_ref: claim.snapshot.identity.lease_ref,
    lease_epoch: claim.snapshot.identity.lease_epoch,
  };
  if (claim.snapshot.settlement_receipt) {
    return {
      receipt: claim.snapshot.settlement_receipt,
      snapshot: claim.snapshot,
      identity: claimedIdentity,
    };
  }

  let decision = classifyRecovery(claim.snapshot);
  if (decision === 'retry_before_effect' && claim.snapshot.attempt_epoch > 0) {
    decision = 'confirm_only';
  }
  if (decision === 'retry_before_effect') {
    return executeClaimed(input.store, input.provider, input.intent, claimedIdentity, input.context);
  }
  if (decision === 'confirm_only' ||
      decision === 'settle_confirmed' ||
      decision === 'settle_no_effect') {
    return confirmAndSettle(
      input.store,
      input.provider,
      input.intent,
      claimedIdentity,
      Math.max(1, claim.snapshot.attempt_epoch),
    );
  }
  return fail('EXECUTION_ESCALATED', 'durable execution facts require escalation', {
    execution_id: input.execution_id,
    lifecycle: claim.snapshot.lifecycle,
  });
}
