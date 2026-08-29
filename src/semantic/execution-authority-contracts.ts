import type { LeaseId, RunId, WorkRef } from './semantic-identities.js';

export const EXECUTION_GATES = [
  'lane:enable',
  'lane:source-implementation',
  'lane:repo-implementation',
  'lane:integration',
  'lane:verification',
] as const;

export type ExecutionGate = (typeof EXECUTION_GATES)[number];

const EXECUTION_GATE_SET = new Set<string>(EXECUTION_GATES);

export function isExecutionGate(value: unknown): value is ExecutionGate {
  return typeof value === 'string' && EXECUTION_GATE_SET.has(value);
}

export type ExecutionAuthorityLocator =
  | Readonly<{ lease_token: string; lease_ref?: never }>
  | Readonly<{ lease_ref: string; lease_token?: never }>;

export type ExecutionAuthorityFail = (
  code: string,
  message: string,
  details?: unknown,
  httpStatus?: number,
) => never;

export function normalizeExecutionAuthorityLocator(
  input: unknown,
  repository: string | null,
  fail: ExecutionAuthorityFail,
): ExecutionAuthorityLocator {
  const value = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const leaseToken = typeof value.lease_token === 'string' ? value.lease_token.trim() : '';
  const leaseRef = typeof value.lease_ref === 'string' ? value.lease_ref.trim() : '';
  if (!leaseToken && !leaseRef) {
    return fail('EXECUTION_AUTHORITY_REQUIRED', 'an active Overcenter work lease is required for this mutation', {
      repository,
    });
  }
  if (leaseToken && leaseRef) {
    return fail('EXECUTION_AUTHORITY_INVALID', 'execution authority locator is ambiguous');
  }
  if (leaseToken.length > 256) {
    return fail('EXECUTION_AUTHORITY_INVALID', 'execution authority token is malformed');
  }
  if (leaseRef.length > 128) {
    return fail('EXECUTION_AUTHORITY_INVALID', 'execution authority lease reference is malformed');
  }
  return leaseRef
    ? Object.freeze({ lease_ref: leaseRef })
    : Object.freeze({ lease_token: leaseToken });
}

export function normalizeAllowedExecutionGates(value: unknown): ReadonlySet<string> {
  const allowedGates = new Set(Array.isArray(value) ? value.map(entry => String(entry)) : []);
  if (allowedGates.size === 0) throw new Error('execution authority allowed_gates must be non-empty');
  return allowedGates;
}

export interface StoredExecutionLease {
  readonly lease_id: string | null;
  readonly work_ref: string | null;
  readonly gate: string | null;
  readonly run_id: string | null;
  readonly status: string | null;
  readonly expires_at: unknown;
  readonly hard_expires_at?: unknown;
  readonly claim_receipt?: unknown;
}

export interface StoredExecutionSlot {
  readonly work_ref: string | null;
  readonly gate: string | null;
  readonly lease_id: string | null;
  readonly expires_at: unknown;
}

export interface StoredExecutionRun {
  readonly run_id: string | null;
  readonly status: string | null;
  readonly deadline_at: unknown;
}

export interface ExecutionAuthorityStore {
  getLeaseByTokenHash(tokenHash: string): Promise<StoredExecutionLease | null>;
  getLeaseById?(leaseId: string): Promise<StoredExecutionLease | null>;
  getSlot(workRef: string, gate: string): Promise<StoredExecutionSlot | null>;
  getRun(runId: string): Promise<StoredExecutionRun | null>;
}

export interface WorkExecutionAuthority {
  readonly subject?: undefined;
  readonly work_ref: WorkRef;
  readonly lease_id: LeaseId;
  readonly run_id: RunId;
  readonly gate: ExecutionGate;
  readonly repository: string;
  readonly execution_fingerprint: string | null;
}

export interface ProjectTransitionExecutionAuthority {
  readonly subject: 'project_transition';
  readonly work_ref: WorkRef;
  readonly lease_id: LeaseId;
  readonly lease_ref: LeaseId;
  readonly run_id: RunId;
  readonly gate: ExecutionGate;
  readonly repository: string;
  readonly project_ref: string;
  readonly transition_id: string;
  readonly authority: unknown | null;
  readonly graph_fingerprint: string | null;
}

export type ExecutionAuthority = WorkExecutionAuthority | ProjectTransitionExecutionAuthority;
