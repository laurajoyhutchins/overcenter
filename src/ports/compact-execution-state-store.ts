import type {
  ExecutionState,
  ExecutionSubjectKind,
  OperationState,
  ProofState,
} from '../semantic/compact-execution-state.js';

export interface AcquireExecutionInput {
  readonly subject_key: string;
  readonly subject_kind: ExecutionSubjectKind;
  readonly project_ref?: string | null;
  readonly transition_id?: string | null;
  readonly lease_ref: string;
  readonly run_id: string;
  readonly authority_repository: string;
  readonly authority_revision: string;
  readonly graph_fingerprint?: string | null;
  readonly transition_revision_fingerprint?: string | null;
  readonly transition_dependency_fingerprint?: string | null;
  readonly expires_at: string;
  readonly hard_expires_at: string;
  readonly active_capability_material?: string | null;
}

export interface WriteCheckpointInput {
  readonly subject_key: string;
  readonly lease_ref: string;
  readonly authority_epoch: number;
  readonly checkpoint: unknown;
  readonly checkpoint_sha256: string;
  readonly updated_at: string;
}

export interface HeartbeatExecutionInput {
  readonly subject_key: string;
  readonly lease_ref: string;
  readonly authority_epoch: number;
  readonly progress_sha256: string;
  readonly expires_at: string;
  readonly heartbeat_at: string;
}

export interface SettleExecutionInput {
  readonly subject_key: string;
  readonly lease_ref: string;
  readonly authority_epoch: number;
  readonly continuation: unknown | null;
  readonly continuation_sha256: string | null;
  readonly continuation_execution_fingerprint: string | null;
  readonly no_progress_streak: number;
  readonly updated_at: string;
}

export interface PrepareOperationInput {
  readonly operation_id: string;
  readonly command: string;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
  readonly request_sha256: string;
  readonly subject_key?: string | null;
  readonly run_id?: string | null;
  readonly lease_epoch?: number | null;
  readonly authority_revision?: string | null;
  readonly created_at: string;
}

export interface MarkOperationIndeterminateInput {
  readonly operation_id: string;
  readonly recovery_payload: unknown;
  readonly effect_kind: string | null;
  readonly effect_ref: string | null;
  readonly effect_sha256: string | null;
}

export interface ResolveOperationInput {
  readonly operation_id: string;
  readonly state: 'succeeded' | 'no_effect' | 'rejected';
  readonly may_have_mutated: boolean;
  readonly effect_kind: string | null;
  readonly effect_ref: string | null;
  readonly effect_sha256: string | null;
  readonly result_sha256: string | null;
  readonly resolution: unknown | null;
  readonly resolved_at: string;
}

export type PutProofInput = ProofState;

export interface CompactRunInput {
  readonly run_id: string;
  readonly active_subject_key: string | null;
  readonly unresolved_operation_id: string | null;
  readonly final_effect_refs: readonly unknown[];
  readonly final_evidence_sha256: string | null;
}

export interface CompactExecutionStateStore {
  getExecution(subjectKey: string): Promise<ExecutionState | null>;
  acquireExecution(input: AcquireExecutionInput): Promise<ExecutionState>;
  writeCheckpoint(input: WriteCheckpointInput): Promise<ExecutionState>;
  heartbeatExecution(input: HeartbeatExecutionInput): Promise<ExecutionState>;
  settleExecution(input: SettleExecutionInput): Promise<ExecutionState>;
  getOperation(command: string, scope: string, key: string): Promise<OperationState | null>;
  getOperationById(operationId: string): Promise<OperationState | null>;
  prepareOperation(input: PrepareOperationInput): Promise<OperationState>;
  markOperationIndeterminate(input: MarkOperationIndeterminateInput): Promise<OperationState>;
  resolveOperation(input: ResolveOperationInput): Promise<OperationState>;
  getProof(proofKey: string): Promise<ProofState | null>;
  putProof(input: PutProofInput): Promise<ProofState>;
  deleteProof(proofKey: string): Promise<void>;
  compactRun(input: CompactRunInput): Promise<void>;
}
