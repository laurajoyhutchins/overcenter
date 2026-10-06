import { canonicalDigest } from '../../digest.ts';
import {
  executionEvidenceReceipt,
  executionEvidenceReceiptDigest,
  type ExecutionEvidenceDescriptor,
  type ExecutionEvidenceReceipt,
} from '../../execution/evidence-receipt.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  isData,
  isPositiveSafeInteger,
} from '../../validation.ts';
import type { CertifiedGitHubSemanticReadEvidence } from './certified-read.ts';
import { isGitHubObjectId, sameGitHubObjectId } from './rest.ts';

export const GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA =
  'overcenter-github-execution-evidence-record/v1' as const;

export interface ObservedGitHubSemanticRead {
  state: 'observed';
  value: unknown;
  evidence: CertifiedGitHubSemanticReadEvidence;
}

export interface GitHubExecutionEvidenceRecord {
  schema: typeof GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA;
  producer: {
    repository_id: number;
    repository_full_name: string;
    workflow_run_id: number;
    workflow_run_attempt: number;
    workflow_job_id: number;
    workflow_path: string;
    job_name: string;
  };
  realization: unknown;
}

export interface GitHubExecutionEvidenceObservation {
  workflow_run: ObservedGitHubSemanticRead;
  workflow_job: ObservedGitHubSemanticRead;
  record: unknown;
}

export interface GitHubExecutionEvidenceExpectation {
  workflow_path: string;
  job_name: string;
  head_branch?: string;
  event?: string;
  workflow_conclusion?: 'success' | 'failure';
}

export interface GitHubExecutionEvidenceProvenance {
  provider: 'github';
  repository_id: number;
  repository_full_name: string;
  workflow_run_id: number;
  workflow_job_id: number;
  run_attempt: number;
  workflow_path: string;
  job_name: string;
  workflow_run_observation_sha256: string;
  workflow_job_observation_sha256: string;
  record_sha256: string;
  receipt_sha256: string;
  observed_at: string[];
}

export interface AdaptedGitHubExecutionEvidence {
  receipt: ExecutionEvidenceReceipt;
  provenance: GitHubExecutionEvidenceProvenance;
}

function requiredString(value: Record<string, unknown>, key: string, error: string): string {
  const member = value[key];
  if (typeof member !== 'string' || member.length === 0) throw new Error(error);
  return member;
}

function requireObservedRead(
  read: ObservedGitHubSemanticRead,
  operationKey: 'workflow_run' | 'workflow_job',
  idParameter: 'run_id' | 'job_id',
): { value: Record<string, unknown>; id: number } {
  const evidence = read.evidence;
  if (evidence.provider !== 'github' || evidence.operation_key !== operationKey) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_CERTIFICATE_MISMATCH');
  }
  const coordinate = evidence.parameters[idParameter];
  if (!isPositiveSafeInteger(coordinate)) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_CERTIFICATE_COORDINATE_INVALID');
  }
  if (!isData(read.value) || !isPositiveSafeInteger(read.value.id)) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_OBSERVATION_INVALID');
  }
  const id = Number(read.value.id);
  if (id !== Number(coordinate)) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_CERTIFICATE_VALUE_MISMATCH');
  }
  return { value: read.value, id };
}

function validateGitHubExecutionEvidenceRecord(value: unknown): GitHubExecutionEvidenceRecord {
  if (!isData(value) || !isData(value.producer)) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_RECORD_INVALID');
  }
  assertExactKeys(
    value,
    ['schema', 'producer', 'realization'],
    [],
    'GITHUB_EXECUTION_EVIDENCE_RECORD_INVALID',
  );
  assertExactKeys(
    value.producer,
    [
      'repository_id',
      'repository_full_name',
      'workflow_run_id',
      'workflow_run_attempt',
      'workflow_job_id',
      'workflow_path',
      'job_name',
    ],
    [],
    'GITHUB_EXECUTION_EVIDENCE_RECORD_INVALID',
  );
  if (
    value.schema !== GITHUB_EXECUTION_EVIDENCE_RECORD_SCHEMA ||
    !isPositiveSafeInteger(value.producer.repository_id) ||
    !isPositiveSafeInteger(value.producer.workflow_run_id) ||
    !isPositiveSafeInteger(value.producer.workflow_run_attempt) ||
    !isPositiveSafeInteger(value.producer.workflow_job_id)
  ) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_RECORD_INVALID');
  }
  assertNonEmptyString(
    value.producer.repository_full_name,
    'GITHUB_EXECUTION_EVIDENCE_RECORD_INVALID',
  );
  assertNonEmptyString(value.producer.workflow_path, 'GITHUB_EXECUTION_EVIDENCE_RECORD_INVALID');
  assertNonEmptyString(value.producer.job_name, 'GITHUB_EXECUTION_EVIDENCE_RECORD_INVALID');
  return value as unknown as GitHubExecutionEvidenceRecord;
}

export function adaptGitHubExecutionEvidence(
  descriptor: ExecutionEvidenceDescriptor,
  observation: GitHubExecutionEvidenceObservation,
  expected: GitHubExecutionEvidenceExpectation,
): AdaptedGitHubExecutionEvidence {
  if (!isGitHubObjectId(descriptor.identity.revision)) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_REVISION_INVALID');
  }
  if (!expected.workflow_path) throw new Error('GITHUB_EXECUTION_WORKFLOW_PATH_INVALID');
  if (!expected.job_name) throw new Error('GITHUB_EXECUTION_JOB_NAME_INVALID');

  const runRead = requireObservedRead(observation.workflow_run, 'workflow_run', 'run_id');
  const jobRead = requireObservedRead(observation.workflow_job, 'workflow_job', 'job_id');
  const run = runRead.value;
  const job = jobRead.value;

  if (
    observation.workflow_run.evidence.repository_id !==
      observation.workflow_job.evidence.repository_id ||
    observation.workflow_run.evidence.requested_repository_full_name.toLowerCase() !==
      observation.workflow_job.evidence.requested_repository_full_name.toLowerCase()
  ) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_REPOSITORY_MISMATCH');
  }

  if (!isPositiveSafeInteger(run.run_attempt)) {
    throw new Error('GITHUB_EXECUTION_WORKFLOW_RUN_IDENTITY_INVALID');
  }
  if (!isPositiveSafeInteger(job.run_id) || !isPositiveSafeInteger(job.run_attempt)) {
    throw new Error('GITHUB_EXECUTION_WORKFLOW_JOB_IDENTITY_INVALID');
  }
  const runAttempt = Number(run.run_attempt);
  const jobRunId = Number(job.run_id);
  const jobRunAttempt = Number(job.run_attempt);
  const repositoryId = observation.workflow_run.evidence.repository_id;
  const repositoryFullName = observation.workflow_run.evidence.requested_repository_full_name;

  const runHead = requiredString(run, 'head_sha', 'GITHUB_EXECUTION_WORKFLOW_RUN_INVALID');
  const jobHead = requiredString(job, 'head_sha', 'GITHUB_EXECUTION_WORKFLOW_JOB_INVALID');
  if (
    !sameGitHubObjectId(runHead, descriptor.identity.revision) ||
    !sameGitHubObjectId(jobHead, descriptor.identity.revision) ||
    run.path !== expected.workflow_path ||
    job.name !== expected.job_name ||
    jobRunId !== runRead.id ||
    jobRunAttempt !== runAttempt ||
    (expected.head_branch !== undefined && run.head_branch !== expected.head_branch) ||
    (expected.event !== undefined && run.event !== expected.event)
  ) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_IDENTITY_MISMATCH');
  }

  const workflowConclusion = expected.workflow_conclusion ?? 'success';
  if (
    run.status !== 'completed' ||
    run.conclusion !== workflowConclusion ||
    job.status !== 'completed' ||
    job.conclusion !== 'success'
  ) {
    throw new Error('GITHUB_EXECUTION_NOT_SUCCESSFUL');
  }

  const record = validateGitHubExecutionEvidenceRecord(observation.record);
  if (
    record.producer.repository_id !== repositoryId ||
    record.producer.repository_full_name.toLowerCase() !== repositoryFullName.toLowerCase() ||
    record.producer.workflow_run_id !== runRead.id ||
    record.producer.workflow_run_attempt !== runAttempt ||
    record.producer.workflow_job_id !== jobRead.id ||
    record.producer.workflow_path !== expected.workflow_path ||
    record.producer.job_name !== expected.job_name
  ) {
    throw new Error('GITHUB_EXECUTION_EVIDENCE_RECORD_PRODUCER_MISMATCH');
  }

  const receipt = executionEvidenceReceipt(descriptor, record.realization);

  return {
    receipt,
    provenance: {
      provider: 'github',
      repository_id: repositoryId,
      repository_full_name: repositoryFullName,
      workflow_run_id: runRead.id,
      workflow_job_id: jobRead.id,
      run_attempt: runAttempt,
      workflow_path: expected.workflow_path,
      job_name: expected.job_name,
      workflow_run_observation_sha256: canonicalDigest(observation.workflow_run),
      workflow_job_observation_sha256: canonicalDigest(observation.workflow_job),
      record_sha256: canonicalDigest(record),
      receipt_sha256: executionEvidenceReceiptDigest(receipt),
      observed_at: [
        observation.workflow_run.evidence.observed_at,
        observation.workflow_job.evidence.observed_at,
      ].sort(),
    },
  };
}
