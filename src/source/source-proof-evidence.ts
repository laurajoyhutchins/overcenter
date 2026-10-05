import { canonicalDigest } from '../digest.ts';
import type {
  ExecutionEvidenceDescriptor,
  ExecutionEvidenceRealization,
  ExecutionEvidenceResult,
} from '../execution/evidence-receipt.ts';
import { isSha256Hex } from '../validation.ts';
import {
  sourceTransactionPlanDigest,
  validateSourceTransactionPlan,
  type SourceTransactionPlan,
} from './transaction.ts';

function sourcePlan(planValue: SourceTransactionPlan): {
  plan: SourceTransactionPlan;
  planDigest: string;
} {
  const plan = validateSourceTransactionPlan(planValue);
  if (
    plan.assurance.validation_mode !== 'baseline' ||
    typeof plan.assurance.baseline_id !== 'string' ||
    plan.assurance.baseline_id.length === 0 ||
    typeof plan.assurance.baseline_sha256 !== 'string' ||
    !isSha256Hex(plan.assurance.baseline_sha256)
  ) {
    throw new Error('SOURCE_PROOF_BASELINE_REQUIRED');
  }
  return { plan, planDigest: sourceTransactionPlanDigest(plan) };
}

export function sourceProofExecutionEvidenceDescriptor(
  planValue: SourceTransactionPlan,
): ExecutionEvidenceDescriptor {
  const { plan, planDigest } = sourcePlan(planValue);
  const needSha256 = canonicalDigest({
    domain: 'overcenter-source-verification-need/v1',
    candidate_sha: plan.candidate_sha,
    plan_sha256: planDigest,
    verification_profile_sha256: plan.verification_profile.sha256,
  });
  return {
    need: {
      id: `source-verification:${needSha256}`,
      sha256: needSha256,
    },
    identity: {
      evidence_id: 'source-verification',
      revision: plan.candidate_sha,
    },
    inputs: {
      source_transaction_plan_sha256: planDigest,
      verification_profile_sha256: plan.verification_profile.sha256,
    },
  };
}

export function sourceProofExecutionEvidenceRealization(
  planValue: SourceTransactionPlan,
  result: ExecutionEvidenceResult,
): ExecutionEvidenceRealization {
  const plan = validateSourceTransactionPlan(planValue);
  const descriptor = sourceProofExecutionEvidenceDescriptor(plan);
  return {
    ...descriptor,
    outputs: {
      verification_state: result === 'satisfied' ? 'verified' : 'rejected',
      verified_tree_sha: plan.candidate_tree,
    },
    semantic_evidence: {
      'source-verification': 'complete',
    },
    observation: { result },
  };
}
