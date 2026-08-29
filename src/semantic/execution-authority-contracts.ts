import type { LeaseId, RunId, WorkRef } from './semantic-identities.js';

export const EXECUTION_GATES = [
  'lane:enable',
  'lane:source-implementation',
  'lane:repo-implementation',
  'lane:integration',
  'lane:verification',
] as const;

export type ExecutionGate = (typeof EXECUTION_GATES)[number];

export type ExecutionAuthorityLocator =
  | Readonly<{ lease_token: string; lease_ref?: never }>
  | Readonly<{ lease_ref: string; lease_token?: never }>;

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
