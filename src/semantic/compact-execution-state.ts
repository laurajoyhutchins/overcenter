export type ExecutionSubjectKind = 'project_transition' | 'legacy_work';
export type ProgressHashWindow = readonly [] | readonly [string] | readonly [string, string];
export type OperationLifecycleState = 'prepared' | 'indeterminate' | 'succeeded' | 'no_effect' | 'rejected';

export interface ExecutionFence {
  readonly subject_key: string;
  readonly authority_epoch: number;
  readonly authority_revision: string;
}

export interface ExecutionState {
  readonly subject_key: string;
  readonly subject_kind: ExecutionSubjectKind;
  readonly project_ref: string | null;
  readonly transition_id: string | null;
  readonly authority_epoch: number;
  readonly lease_ref: string | null;
  readonly run_id: string | null;
  readonly authority_repository: string | null;
  readonly authority_revision: string | null;
  readonly graph_fingerprint: string | null;
  readonly transition_revision_fingerprint: string | null;
  readonly transition_dependency_fingerprint: string | null;
  readonly expires_at: string | null;
  readonly hard_expires_at: string | null;
  readonly active_capability_material: string | null;
  readonly checkpoint: unknown | null;
  readonly checkpoint_sha256: string | null;
  readonly recent_progress_sha256: ProgressHashWindow;
  readonly heartbeat_count: number;
  readonly last_heartbeat_at: string | null;
  readonly continuation: unknown | null;
  readonly continuation_sha256: string | null;
  readonly continuation_execution_fingerprint: string | null;
  readonly no_progress_streak: number;
  readonly updated_at: string;
}

export interface OperationState {
  readonly operation_id: string;
  readonly command: string;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
  readonly request_sha256: string;
  readonly state: OperationLifecycleState;
  readonly subject_key: string | null;
  readonly run_id: string | null;
  readonly lease_epoch: number | null;
  readonly authority_revision: string | null;
  readonly may_have_mutated: boolean;
  readonly effect_kind: string | null;
  readonly effect_ref: string | null;
  readonly effect_sha256: string | null;
  readonly result_sha256: string | null;
  readonly recovery_payload: unknown | null;
  readonly resolution: unknown | null;
  readonly created_at: string;
  readonly resolved_at: string | null;
}

export interface ProofEvidenceRef {
  readonly kind: string;
  readonly ref: string;
}

export interface ProofState {
  readonly proof_key: string;
  readonly subject_key: string | null;
  readonly predicate_kind: string;
  readonly authority_repository: string;
  readonly authority_revision: string;
  readonly evidence_sha256: string;
  readonly evidence_refs: readonly ProofEvidenceRef[];
  readonly satisfied_at: string;
  readonly consumed_at: string | null;
}

type CompactableOperation = Pick<OperationState, 'state' | 'may_have_mutated' | 'effect_ref'>;

function failExecutionState(message: string, details: unknown = null): never {
  throw Object.assign(new Error(message), { code:'EXECUTION_STATE_INVALID', details });
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    return failExecutionState(`${field} must be a non-negative integer`, { field, value });
  }
  return Number(value);
}

function requiredText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return failExecutionState(`${field} is required`, { field });
  return text;
}

export function assertExecutionState(value: unknown): asserts value is ExecutionState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    failExecutionState('execution state must be an object');
  }
  const state = value as Record<string, unknown>;
  requiredText(state.subject_key, 'subject_key');
  if (state.subject_kind !== 'project_transition' && state.subject_kind !== 'legacy_work') {
    failExecutionState('subject_kind is invalid', { subject_kind:state.subject_kind });
  }
  nonNegativeInteger(state.authority_epoch, 'authority_epoch');
  nonNegativeInteger(state.heartbeat_count, 'heartbeat_count');
  nonNegativeInteger(state.no_progress_streak, 'no_progress_streak');

  if (!Array.isArray(state.recent_progress_sha256) || state.recent_progress_sha256.length > 2) {
    failExecutionState('recent_progress_sha256 must contain at most two hashes', {
      count:Array.isArray(state.recent_progress_sha256) ? state.recent_progress_sha256.length : null,
    });
  }
  for (const hash of state.recent_progress_sha256) {
    requiredText(hash, 'recent_progress_sha256');
  }

  const leaseRef = state.lease_ref == null ? null : requiredText(state.lease_ref, 'lease_ref');
  if (leaseRef) {
    requiredText(state.run_id, 'run_id');
    requiredText(state.authority_repository, 'authority_repository');
    requiredText(state.authority_revision, 'authority_revision');
    requiredText(state.expires_at, 'expires_at');
    requiredText(state.hard_expires_at, 'hard_expires_at');
  }
  requiredText(state.updated_at, 'updated_at');
}

export function assertTerminalOperationCompactable(operation: CompactableOperation): void {
  if (operation.state === 'prepared' || operation.state === 'indeterminate') {
    throw Object.assign(new Error('operation is not terminal'), { code:'OPERATION_NOT_COMPACTABLE' });
  }
  if (operation.state === 'succeeded' && operation.may_have_mutated && !operation.effect_ref) {
    throw Object.assign(new Error('successful mutation lacks a proven effect identity'), { code:'OPERATION_EFFECT_UNPROVEN' });
  }
}
