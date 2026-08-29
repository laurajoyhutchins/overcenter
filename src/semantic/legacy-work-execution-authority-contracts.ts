import type { LeaseId, RunId, WorkRef } from './semantic-identities.js';

export const LEGACY_WORK_EXECUTION_GATES = [
  'lane:enable',
  'lane:source-implementation',
  'lane:repo-implementation',
  'lane:integration',
  'lane:verification',
] as const;

export type LegacyWorkExecutionGate = (typeof LEGACY_WORK_EXECUTION_GATES)[number];

const LEGACY_WORK_EXECUTION_GATE_SET = new Set<string>(LEGACY_WORK_EXECUTION_GATES);

export function isLegacyWorkExecutionGate(value: unknown): value is LegacyWorkExecutionGate {
  return typeof value === 'string' && LEGACY_WORK_EXECUTION_GATE_SET.has(value);
}

export function normalizeAllowedLegacyWorkExecutionGates(value: unknown): ReadonlySet<string> {
  const allowedGates = new Set(Array.isArray(value) ? value.map(entry => String(entry)) : []);
  if (allowedGates.size === 0) throw new Error('legacy work execution authority allowed_gates must be non-empty');
  return allowedGates;
}

export interface LegacyWorkExecutionAuthority {
  readonly subject?: undefined;
  readonly work_ref: WorkRef;
  readonly lease_id: LeaseId;
  readonly run_id: RunId;
  readonly gate: LegacyWorkExecutionGate;
  readonly repository: string;
  readonly execution_fingerprint: string | null;
}