import { isPositiveSafeInteger } from '../validation.ts';
import {
  sourceTransactionPlanDigest,
  validateSourceTransactionPlan,
  type SourceTransactionPlan,
} from './transaction.ts';

export interface AdmittedSourceProof {
  schema: 'overcenter-admitted-source-proof/v1';
  state: 'verified';
  reason: null;
  run_id: string;
  candidate_sha: string;
  base_sha: string;
  tree_sha: string;
  runtime_sha: string;
  plan_digest: string;
  producer: {
    repository_id: number;
    repository_full_name: string;
    workflow_path: string;
    workflow_run_id: number;
    workflow_run_attempt: number;
    job_id: number;
  };
}

export interface SourceProofContext {
  repository_id: number;
  repository_full_name: string;
  runtime_sha: string;
  baseline_id: string;
}

export interface SourceProofRecord {
  schema: 'overcenter-source-verification';
  schema_version: 2;
  state: 'verified' | 'rejected';
  reason: string | null;
  run_id: string;
  candidate_sha: string;
  base_sha: string;
  tree_sha: string;
  runtime_sha: string;
  plan_digest: string;
  model_sha256: string;
  dependency_sha256: string;
  baseline_id: string;
  baseline_sha256: string;
  producer: {
    repository_id: number;
    repository_full_name: string;
    workflow_path: string;
    workflow_run_id: number;
    workflow_run_attempt: number;
    job_name: string;
    job_id: number;
  };
}

const WORKFLOW = '.github/workflows/agent-candidate-signal.yml';
const RECORD_JOB = 'Record source verification';

export function sourceProofRecord(
  planValue: SourceTransactionPlan,
  producer: { workflow_run_id: number; workflow_run_attempt: number; job_id: number },
  result: string,
): SourceProofRecord {
  const plan = validateSourceTransactionPlan(planValue);
  if (
    plan.assurance.validation_mode !== 'baseline' ||
    !plan.assurance.baseline_id ||
    !plan.assurance.baseline_sha256
  )
    throw new Error('SOURCE_PROOF_BASELINE_REQUIRED');
  if (
    !isPositiveSafeInteger(producer.workflow_run_id) ||
    !isPositiveSafeInteger(producer.workflow_run_attempt) ||
    !isPositiveSafeInteger(producer.job_id)
  )
    throw new Error('SOURCE_PROOF_PRODUCER_INVALID');
  return {
    schema: 'overcenter-source-verification',
    schema_version: 2,
    state: result === 'success' ? 'verified' : 'rejected',
    reason: result === 'success' ? null : 'SOURCE_VERIFICATION_FAILED',
    run_id: plan.claim.run_id,
    candidate_sha: plan.candidate_sha,
    base_sha: plan.claim.source_sha,
    tree_sha: plan.candidate_tree,
    runtime_sha: plan.runtime_sha,
    plan_digest: sourceTransactionPlanDigest(plan),
    model_sha256: plan.assurance.model_sha256,
    dependency_sha256: plan.assurance.dependency_sha256,
    baseline_id: plan.assurance.baseline_id,
    baseline_sha256: plan.assurance.baseline_sha256,
    producer: {
      repository_id: plan.repository_id,
      repository_full_name: plan.repository_full_name,
      workflow_path: WORKFLOW,
      workflow_run_id: producer.workflow_run_id,
      workflow_run_attempt: producer.workflow_run_attempt,
      job_name: RECORD_JOB,
      job_id: producer.job_id,
    },
  };
}
