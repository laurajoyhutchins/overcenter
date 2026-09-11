import type {
  ExecutionIdentity,
  ExecutionLifecycle,
  ExecutionProof,
  ExecutionSnapshot,
  MutationCertainty,
  ProviderConfirmationFacts,
  ProviderInvocationFacts,
  SettlementReceipt,
} from './execution-transaction.js';

export interface PrepareExecutionInput {
  readonly identity: ExecutionIdentity;
  readonly lifecycle: 'prepared';
}

export interface ClaimExecutionInput {
  readonly execution_id: string;
  readonly lease_ref: string;
  readonly lease_epoch: number;
  readonly authority_epoch: number;
  readonly lease_expires_at: string;
}

export interface HeartbeatExecutionInput {
  readonly execution_id: string;
  readonly lease_ref: string;
  readonly lease_epoch: number;
  readonly authority_epoch: number;
  readonly lease_expires_at: string;
}

export interface OperationAttempt {
  readonly operation_id: string;
  readonly execution_id: string;
  readonly attempt_epoch: number;
  readonly request_sha256: string;
  readonly mutation_certainty: MutationCertainty;
  readonly effect_ref: string | null;
  readonly response_sha256: string | null;
}

export interface RecordAttemptInput {
  readonly identity: ExecutionIdentity;
  readonly attempt_epoch: number;
  readonly request_sha256: string;
}

export interface RecordInvocationInput {
  readonly identity: ExecutionIdentity;
  readonly attempt_epoch: number;
  readonly facts: ProviderInvocationFacts | ProviderConfirmationFacts;
}

export interface AppendProofInput extends ExecutionProof {
  readonly predicate: string;
  readonly evidence_sha256: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface SettleExecutionInput {
  readonly identity: ExecutionIdentity;
  readonly attempt_epoch: number;
  readonly disposition: SettlementReceipt['disposition'];
  readonly effect_ref: string | null;
  readonly evidence_sha256: string;
}

export type ClaimResult =
  | { readonly kind: 'claimed'; readonly snapshot: ExecutionSnapshot }
  | { readonly kind: 'replayed'; readonly snapshot: ExecutionSnapshot }
  | { readonly kind: 'busy'; readonly snapshot: ExecutionSnapshot };

export interface ExecutionTransactionStore {
  prepareExecution(input: PrepareExecutionInput): Promise<ExecutionSnapshot>;
  claimExecution(input: ClaimExecutionInput): Promise<ClaimResult>;
  heartbeatExecution(input: HeartbeatExecutionInput): Promise<ExecutionSnapshot>;
  recordAttempt(input: RecordAttemptInput): Promise<OperationAttempt>;
  recordInvocation(input: RecordInvocationInput): Promise<OperationAttempt>;
  appendProof(input: AppendProofInput): Promise<ExecutionProof>;
  settleExecution(input: SettleExecutionInput): Promise<SettlementReceipt>;
  readExecution(executionId: string): Promise<ExecutionSnapshot | null>;
}
