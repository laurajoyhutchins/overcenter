import { canonicalDigest } from '../digest.ts';
import type { AssuranceEvidenceNeed } from '../source/assurance-evidence-needs.ts';
import {
  normalizeExecutionEvidenceReceipt,
  sameExecutionEvidenceReceipt,
  type ExecutionEvidenceDescriptor,
  type ExecutionEvidenceReceipt,
} from './evidence-receipt.ts';

export type DifferentialExecutionEvidenceResult =
  | {
      state: 'equivalent';
      receipt: ExecutionEvidenceReceipt;
    }
  | {
      state: 'evidence-failure';
      reason: 'invalid-receipt' | 'substrate-discrepancy';
    };

export function executionEvidenceDescriptorForAssuranceNeed(
  need: AssuranceEvidenceNeed,
): ExecutionEvidenceDescriptor {
  return {
    need: {
      id: need.need_id,
      sha256: canonicalDigest(need),
    },
    identity: structuredClone(need.identity),
    inputs: structuredClone(need.inputs),
  };
}

export function compareExecutionEvidenceReceipts(
  left: unknown,
  right: unknown,
): DifferentialExecutionEvidenceResult {
  let normalizedLeft: ExecutionEvidenceReceipt;
  let normalizedRight: ExecutionEvidenceReceipt;
  try {
    normalizedLeft = normalizeExecutionEvidenceReceipt(left);
    normalizedRight = normalizeExecutionEvidenceReceipt(right);
  } catch {
    return { state: 'evidence-failure', reason: 'invalid-receipt' };
  }
  if (!sameExecutionEvidenceReceipt(normalizedLeft, normalizedRight)) {
    return { state: 'evidence-failure', reason: 'substrate-discrepancy' };
  }
  return { state: 'equivalent', receipt: normalizedLeft };
}
