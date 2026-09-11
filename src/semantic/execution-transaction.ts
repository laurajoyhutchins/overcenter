import type { JsonValue } from './project-graph-types.js';

export type JsonObject = { readonly [key: string]: JsonValue };

export type ExecutionLifecycle =
  | 'prepared'
  | 'executing'
  | 'effect_uncertain'
  | 'effect_confirmed'
  | 'effect_absent'
  | 'settled'
  | 'rejected'
  | 'escalated';

export type MutationCertainty =
  | 'definitely_not_mutated'
  | 'may_have_mutated'
  | 'confirmed_mutated';

export interface ExecutionAuthority {
  readonly project_ref: string;
  readonly repository: string;
  readonly revision: string;
  readonly epoch: number;
  readonly graph_fingerprint: string;
  readonly transition_fingerprint: string;
}

export interface ExecutionIntent<TPayload = JsonValue> {
  readonly project_ref: string;
  readonly subject_key: string;
  readonly authority: ExecutionAuthority;
  readonly operation: {
    readonly kind: string;
    readonly idempotency_scope: string;
    readonly idempotency_key: string;
    readonly payload: TPayload;
  };
}

export interface ExecutionIdentity {
  readonly execution_id: string;
  readonly operation_id: string;
  readonly project_ref: string;
  readonly subject_key: string;
  readonly run_id: string;
  readonly lease_ref: string;
  readonly lease_epoch: number;
  readonly authority_epoch: number;
  readonly authority_repository: string;
  readonly authority_revision: string;
  readonly graph_fingerprint: string;
  readonly transition_fingerprint: string;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
  readonly intent_sha256: string;
}

export interface ExecutionSnapshot {
  readonly identity: ExecutionIdentity;
  readonly lifecycle: ExecutionLifecycle;
  readonly attempt_epoch: number;
  readonly mutation_certainty: MutationCertainty;
  readonly effect_ref: string | null;
  readonly proof_ids: readonly string[];
  readonly settled: boolean;
}

export type ProviderEffectPayload<TPayload extends JsonObject = JsonObject> = TPayload & Readonly<{
  readonly lease_ref?: never;
  readonly lease_epoch?: never;
  readonly authority_epoch?: never;
  readonly settlement?: never;
}>;

export interface ProviderInvocationFacts {
  readonly transport: 'rejected' | 'accepted' | 'unknown';
  readonly committed: boolean | null;
  readonly effect_ref: string | null;
  readonly response_sha256: string | null;
  readonly evidence: JsonObject | null;
}

export interface ProviderConfirmationFacts {
  readonly status: 'confirmed' | 'absent' | 'unknown';
  readonly effect_ref: string | null;
  readonly predicate: string;
  readonly evidence: JsonObject;
}

export interface ExecutionProof {
  readonly proof_id: string;
  readonly execution_id: string;
  readonly operation_id: string;
  readonly attempt_epoch: number;
  readonly authority_repository: string;
  readonly authority_revision: string;
  readonly authority_epoch: number;
  readonly predicate: string;
  readonly evidence_sha256: string;
}

export interface SettlementReceipt {
  readonly schema: 'settlement-receipt-v1';
  readonly execution_id: string;
  readonly operation_id: string;
  readonly authority_revision: string;
  readonly authority_epoch: number;
  readonly lifecycle: 'settled';
  readonly disposition: 'completed' | 'no_effect' | 'rejected' | 'escalated';
  readonly effect_ref: string | null;
  readonly evidence_sha256: string;
}

export type RecoveryDecision =
  | 'retry_before_effect'
  | 'confirm_only'
  | 'settle_confirmed'
  | 'settle_no_effect'
  | 'escalate';

const TRANSITIONS: Readonly<Record<ExecutionLifecycle, readonly ExecutionLifecycle[]>> = {
  prepared: ['executing', 'rejected'],
  executing: ['effect_uncertain', 'effect_confirmed', 'effect_absent', 'rejected', 'escalated'],
  effect_uncertain: ['effect_confirmed', 'effect_absent', 'escalated'],
  effect_confirmed: ['settled', 'escalated'],
  effect_absent: ['settled', 'escalated'],
  settled: [],
  rejected: [],
  escalated: [],
};

const CERTAINTY_RANK: Readonly<Record<MutationCertainty, number>> = {
  definitely_not_mutated: 0,
  may_have_mutated: 1,
  confirmed_mutated: 2,
};

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`${field} is required`), {
      code: 'EXECUTION_TRANSACTION_INVALID',
      field,
    });
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw Object.assign(new Error(`${field} must be a non-negative integer`), {
      code: 'EXECUTION_TRANSACTION_INVALID',
      field,
    });
  }
  return Number(value);
}

function validLifecycle(value: unknown): value is ExecutionLifecycle {
  return typeof value === 'string' && Object.hasOwn(TRANSITIONS, value);
}

function validCertainty(value: unknown): value is MutationCertainty {
  return value === 'definitely_not_mutated' ||
    value === 'may_have_mutated' ||
    value === 'confirmed_mutated';
}

export function canTransition(from: ExecutionLifecycle, to: ExecutionLifecycle): boolean {
  return TRANSITIONS[from].includes(to);
}

export function mutationCertaintyFromFacts(
  facts: ProviderInvocationFacts | ProviderConfirmationFacts,
): MutationCertainty {
  if ('status' in facts) {
    if (facts.status === 'confirmed') return 'confirmed_mutated';
    if (facts.status === 'absent') return 'definitely_not_mutated';
    return 'may_have_mutated';
  }

  if (facts.transport === 'rejected' && facts.committed === false) {
    return 'definitely_not_mutated';
  }
  if (facts.transport === 'accepted' && facts.committed === true) {
    return 'confirmed_mutated';
  }
  return 'may_have_mutated';
}

export function classifyRecovery(snapshot: ExecutionSnapshot): RecoveryDecision {
  if (snapshot.settled || snapshot.lifecycle === 'settled' || snapshot.lifecycle === 'escalated') {
    return 'escalate';
  }

  if (snapshot.mutation_certainty === 'confirmed_mutated' ||
      snapshot.lifecycle === 'effect_confirmed') {
    return 'settle_confirmed';
  }

  if (snapshot.mutation_certainty === 'definitely_not_mutated' &&
      (snapshot.lifecycle === 'effect_absent' || snapshot.lifecycle === 'effect_uncertain')) {
    return 'settle_no_effect';
  }

  if (snapshot.mutation_certainty === 'may_have_mutated' ||
      snapshot.lifecycle === 'effect_uncertain') {
    return 'confirm_only';
  }

  if (snapshot.lifecycle === 'prepared' ||
      snapshot.lifecycle === 'executing' ||
      snapshot.lifecycle === 'rejected') {
    return 'retry_before_effect';
  }

  return 'escalate';
}

export function assertExecutionIdentity(value: unknown): asserts value is ExecutionIdentity {
  const identity = recordOf(value);
  if (!identity) throw new Error('execution identity must be an object');

  for (const field of [
    'execution_id',
    'operation_id',
    'project_ref',
    'subject_key',
    'run_id',
    'lease_ref',
    'authority_repository',
    'authority_revision',
    'graph_fingerprint',
    'transition_fingerprint',
    'idempotency_scope',
    'idempotency_key',
    'intent_sha256',
  ]) {
    requiredText(identity[field], field);
  }
  nonNegativeInteger(identity.lease_epoch, 'lease_epoch');
  nonNegativeInteger(identity.authority_epoch, 'authority_epoch');
}

export function assertExecutionSnapshot(value: unknown): asserts value is ExecutionSnapshot {
  const snapshot = recordOf(value);
  if (!snapshot) throw new Error('execution snapshot must be an object');
  assertExecutionIdentity(snapshot.identity);
  if (!validLifecycle(snapshot.lifecycle)) {
    throw new Error('execution snapshot lifecycle is invalid');
  }
  if (!validCertainty(snapshot.mutation_certainty)) {
    throw new Error('execution snapshot mutation certainty is invalid');
  }
  nonNegativeInteger(snapshot.attempt_epoch, 'attempt_epoch');
  if (!Array.isArray(snapshot.proof_ids) || snapshot.proof_ids.some((proofId) => typeof proofId !== 'string')) {
    throw new Error('execution snapshot proof_ids is invalid');
  }
  if (typeof snapshot.settled !== 'boolean') {
    throw new Error('execution snapshot settled is invalid');
  }
}

export function assertSettlementReceipt(value: unknown): asserts value is SettlementReceipt {
  const receipt = recordOf(value);
  if (!receipt) throw new Error('settlement receipt must be an object');
  if (receipt.schema !== 'settlement-receipt-v1' || receipt.lifecycle !== 'settled') {
    throw new Error('settlement receipt schema is invalid');
  }
  for (const field of [
    'execution_id',
    'operation_id',
    'authority_revision',
    'evidence_sha256',
  ]) {
    requiredText(receipt[field], field);
  }
  nonNegativeInteger(receipt.authority_epoch, 'authority_epoch');
  if (!['completed', 'no_effect', 'rejected', 'escalated'].includes(String(receipt.disposition))) {
    throw new Error('settlement receipt disposition is invalid');
  }
}

export const executionTransactionInternals = Object.freeze({
  certaintyRank: CERTAINTY_RANK,
  transitions: TRANSITIONS,
});
