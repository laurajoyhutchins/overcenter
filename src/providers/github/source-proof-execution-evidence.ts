import {
  adaptGitHubExecutionEvidence,
  GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA,
  type GitHubExecutionEvidenceRecord,
  type ObservedGitHubSemanticRead,
} from './execution-evidence-receipt.ts';
import {
  observeCertifiedGitHubSemanticRead,
  type CertifiedGitHubSemanticReadResult,
} from './certified-read.ts';
import { githubGet, type GitHubJsonGet } from './rest.ts';
import type {
  ExecutionEvidenceReceipt,
  ExecutionEvidenceResult,
} from '../../execution/evidence-receipt.ts';
import { observeGitHubSourceProof } from '../../source/github-source-proof-observation.ts';
import {
  sourceProofExecutionEvidenceDescriptor,
  sourceProofExecutionEvidenceRealization,
} from '../../source/source-proof-evidence.ts';
import {
  sourceTransactionPlanDigest,
  validateSourceTransactionPlan,
  type SourceTransactionPlan,
} from '../../source/transaction.ts';
import { isData, isPositiveSafeInteger } from '../../validation.ts';

function observed(
  result: CertifiedGitHubSemanticReadResult,
  error: string,
): ObservedGitHubSemanticRead {
  if (result.state !== 'observed') {
    const detail = result.state === 'indeterminate' ? result.observation_error : result.state;
    throw new Error(`${error}:${detail}`);
  }
  return { state: 'observed', value: result.value, evidence: result.evidence };
}

function sourceResult(
  plan: SourceTransactionPlan,
  recordValue: unknown,
): {
  result: ExecutionEvidenceResult;
  producer: {
    repository_id: number;
    repository_full_name: string;
    workflow_path: string;
    workflow_run_id: number;
    workflow_run_attempt: number;
    job_name: string;
    job_id: number;
  };
} {
  if (!isData(recordValue) || !isData(recordValue.producer)) {
    throw new Error('SOURCE_PROOF_RECORD_INVALID');
  }
  const assurance = plan.assurance;
  const rejected = recordValue.state === 'rejected';
  if (
    recordValue.schema !== 'overcenter-source-verification' ||
    recordValue.schema_version !== 3 ||
    (rejected
      ? recordValue.reason !== 'SOURCE_VERIFICATION_FAILED'
      : recordValue.state !== 'verified' || recordValue.reason !== null) ||
    recordValue.run_id !== plan.claim.run_id ||
    recordValue.candidate_sha !== plan.candidate_sha ||
    recordValue.base_sha !== plan.claim.source_sha ||
    recordValue.tree_sha !== plan.candidate_tree ||
    recordValue.runtime_sha !== plan.runtime_sha ||
    recordValue.plan_digest !== sourceTransactionPlanDigest(plan) ||
    recordValue.model_sha256 !== assurance.model_sha256 ||
    recordValue.dependency_sha256 !== assurance.dependency_sha256 ||
    recordValue.baseline_id !== assurance.baseline_id ||
    recordValue.baseline_sha256 !== assurance.baseline_sha256 ||
    recordValue.verification_profile_id !== plan.verification_profile.profile.id ||
    recordValue.verification_profile_sha256 !== plan.verification_profile.sha256
  ) {
    throw new Error('SOURCE_PROOF_BINDING_MISMATCH');
  }
  const producer = recordValue.producer;
  if (
    !isPositiveSafeInteger(producer.repository_id) ||
    typeof producer.repository_full_name !== 'string' ||
    producer.repository_full_name.length === 0 ||
    typeof producer.workflow_path !== 'string' ||
    producer.workflow_path.length === 0 ||
    !isPositiveSafeInteger(producer.workflow_run_id) ||
    !isPositiveSafeInteger(producer.workflow_run_attempt) ||
    typeof producer.job_name !== 'string' ||
    producer.job_name.length === 0 ||
    !isPositiveSafeInteger(producer.job_id)
  ) {
    throw new Error('SOURCE_PROOF_PRODUCER_INVALID');
  }
  return {
    result: rejected ? 'unsatisfied' : 'satisfied',
    producer: {
      repository_id: producer.repository_id,
      repository_full_name: producer.repository_full_name,
      workflow_path: producer.workflow_path,
      workflow_run_id: producer.workflow_run_id,
      workflow_run_attempt: producer.workflow_run_attempt,
      job_name: producer.job_name,
      job_id: producer.job_id,
    },
  };
}

export function observeGitHubSourceProofExecutionEvidence(
  token: string,
  planValue: SourceTransactionPlan,
  recordValue: unknown,
  {
    workflowRunId,
    workflowRunAttempt,
    get = githubGet,
    clock = () => new Date().toISOString(),
  }: {
    workflowRunId: number;
    workflowRunAttempt: number;
    get?: GitHubJsonGet;
    clock?: () => string;
  },
): ExecutionEvidenceReceipt {
  const plan = validateSourceTransactionPlan(planValue);
  const { result, producer } = sourceResult(plan, recordValue);
  const profile = plan.verification_profile.profile;
  if (
    !isPositiveSafeInteger(workflowRunId) ||
    !isPositiveSafeInteger(workflowRunAttempt) ||
    producer.repository_id !== plan.repository_id ||
    producer.repository_full_name !== plan.repository_full_name ||
    producer.workflow_path !== profile.workflow_path ||
    producer.workflow_run_id !== workflowRunId ||
    producer.workflow_run_attempt !== workflowRunAttempt ||
    producer.job_name !== profile.record_job ||
    !isPositiveSafeInteger(producer.job_id)
  ) {
    throw new Error('SOURCE_PROOF_PRODUCER_INVALID');
  }

  const sourceObservation = observeGitHubSourceProof(token, {
    repositoryId: plan.repository_id,
    repositoryFullName: plan.repository_full_name,
    workflowRunId,
    workflowRunAttempt,
    get,
    clock,
  });
  for (const name of [...profile.required_evidence_jobs, profile.record_job]) {
    const matches = sourceObservation.jobs.filter((job) => job.name === name);
    const job = matches[0];
    const expectedConclusion =
      name === profile.record_job ? 'success' : result === 'satisfied' ? 'success' : 'failure';
    if (
      matches.length !== 1 ||
      !job ||
      job.run_id !== workflowRunId ||
      job.head_sha !== plan.candidate_sha ||
      job.status !== 'completed' ||
      job.conclusion !== expectedConclusion ||
      (name === profile.record_job && job.id !== producer.job_id)
    ) {
      throw new Error(`SOURCE_PROOF_JOB_INVALID:${name}`);
    }
  }

  const runRead = observed(
    observeCertifiedGitHubSemanticRead(token, {
      repositoryId: plan.repository_id,
      repositoryFullName: plan.repository_full_name,
      operation: 'workflow_run',
      parameters: { run_id: workflowRunId },
      grantedPermissions: ['actions:read'],
      get,
      clock,
    }),
    'SOURCE_PROOF_WORKFLOW_OBSERVATION_INVALID',
  );
  const recordJobRead = observed(
    observeCertifiedGitHubSemanticRead(token, {
      repositoryId: plan.repository_id,
      repositoryFullName: plan.repository_full_name,
      operation: 'workflow_job',
      parameters: { job_id: producer.job_id },
      grantedPermissions: ['actions:read'],
      get,
      clock,
    }),
    'SOURCE_PROOF_RECORD_JOB_OBSERVATION_INVALID',
  );

  const record: GitHubExecutionEvidenceRecord = {
    schema: GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA,
    producer: {
      repository_id: producer.repository_id,
      repository_full_name: producer.repository_full_name,
      workflow_run_id: producer.workflow_run_id,
      workflow_run_attempt: producer.workflow_run_attempt,
      workflow_job_id: producer.job_id,
      workflow_path: producer.workflow_path,
      job_name: producer.job_name,
    },
    realization: sourceProofExecutionEvidenceRealization(plan, result),
  };

  return adaptGitHubExecutionEvidence(
    sourceProofExecutionEvidenceDescriptor(plan),
    {
      workflow_run: runRead,
      workflow_job: recordJobRead,
      record,
    },
    {
      workflow_path: profile.workflow_path,
      job_name: profile.record_job,
      head_branch: `overcenter/candidate/${plan.claim.run_id}`,
      event: 'workflow_dispatch',
      workflow_conclusion: result === 'satisfied' ? 'success' : 'failure',
    },
  ).receipt;
}
