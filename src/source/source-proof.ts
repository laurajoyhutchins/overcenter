import { verifyGitHubSourceProofObservation } from './github-source-proof-observation.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  isData,
  isPositiveSafeInteger,
  isSha256Hex,
} from '../validation.ts';
import type { AdmittedSourceProof, SourceProofContext } from './source-proof-record.ts';
import {
  sourceTransactionPlanDigest,
  validateSourceTransactionPlan,
  type SourceTransactionPlan,
} from './transaction.ts';
export type { AdmittedSourceProof } from './source-proof-record.ts';

export class SourceProofRejected extends Error {
  constructor() {
    super('SOURCE_VERIFICATION_FAILED');
    this.name = 'SourceProofRejected';
  }
}

const proofs = new WeakMap<object, AdmittedSourceProof>();
declare const sourceProofBrand: unique symbol;
export type TrustedSourceProofWitness = { readonly [sourceProofBrand]: true };

function exactSha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))
    throw new Error('SOURCE_PROOF_BINDING_MISMATCH');
}

export function admitSourceProof(
  planValue: SourceTransactionPlan,
  recordValue: unknown,
  {
    githubToken,
    expectedWorkflowRunId,
    expectedWorkflowRunAttempt,
    context,
    get,
  }: {
    githubToken: string;
    expectedWorkflowRunId: number;
    expectedWorkflowRunAttempt: number;
    context: SourceProofContext;
    get: (token: string, path: string) => unknown;
  },
): TrustedSourceProofWitness {
  const plan = validateSourceTransactionPlan(planValue);
  const planDigest = sourceTransactionPlanDigest(plan);
  if (!isData(recordValue) || !isData(recordValue.producer) || !isData(plan.assurance))
    throw new Error('SOURCE_PROOF_RECORD_INVALID');
  const producer = recordValue.producer;
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
    recordValue.plan_digest !== planDigest ||
    recordValue.model_sha256 !== assurance.model_sha256 ||
    recordValue.dependency_sha256 !== assurance.dependency_sha256 ||
    recordValue.baseline_id !== assurance.baseline_id ||
    recordValue.baseline_sha256 !== assurance.baseline_sha256 ||
    recordValue.verification_profile_id !== plan.verification_profile.profile.id ||
    recordValue.verification_profile_sha256 !== plan.verification_profile.sha256 ||
    context.repository_id !== plan.repository_id ||
    context.repository_full_name !== plan.repository_full_name ||
    context.runtime_sha !== plan.runtime_sha ||
    context.verification_profile_id !== plan.verification_profile.profile.id ||
    context.verification_profile_sha256 !== plan.verification_profile.sha256
  )
    throw new Error('SOURCE_PROOF_BINDING_MISMATCH');
  exactSha(recordValue.tree_sha);
  if (
    producer.repository_id !== plan.repository_id ||
    producer.repository_full_name !== plan.repository_full_name ||
    producer.workflow_path !== plan.verification_profile.profile.workflow_path ||
    producer.workflow_run_id !== expectedWorkflowRunId ||
    producer.workflow_run_attempt !== expectedWorkflowRunAttempt ||
    producer.job_name !== plan.verification_profile.profile.record_job ||
    !isPositiveSafeInteger(producer.job_id) ||
    !isPositiveSafeInteger(expectedWorkflowRunId) ||
    !isPositiveSafeInteger(expectedWorkflowRunAttempt)
  )
    throw new Error('SOURCE_PROOF_PRODUCER_INVALID');

  verifyGitHubSourceProofObservation(
    githubToken,
    {
      repository_id: plan.repository_id,
      repository_full_name: plan.repository_full_name,
      workflow_path: plan.verification_profile.profile.workflow_path,
      workflow_run_id: expectedWorkflowRunId,
      workflow_run_attempt: expectedWorkflowRunAttempt,
      candidate_sha: plan.candidate_sha,
      candidate_branch: `overcenter/candidate/${plan.claim.run_id}`,
      required_evidence_jobs: plan.verification_profile.profile.required_evidence_jobs,
      record_job: plan.verification_profile.profile.record_job,
      record_job_id: producer.job_id,
      rejected,
    },
    get,
  );

  if (rejected) throw new SourceProofRejected();

  const proof = validateAdmittedSourceProof({
    schema: 'overcenter-admitted-source-proof/v2',
    state: 'verified',
    reason: null,
    run_id: plan.claim.run_id,
    candidate_sha: plan.candidate_sha,
    base_sha: plan.claim.source_sha,
    tree_sha: recordValue.tree_sha,
    runtime_sha: plan.runtime_sha,
    plan_digest: planDigest,
    verification_profile_id: plan.verification_profile.profile.id,
    verification_profile_sha256: plan.verification_profile.sha256,
    producer: {
      repository_id: plan.repository_id,
      repository_full_name: plan.repository_full_name,
      workflow_path: plan.verification_profile.profile.workflow_path,
      workflow_run_id: expectedWorkflowRunId,
      workflow_run_attempt: expectedWorkflowRunAttempt,
      job_id: producer.job_id,
    },
  });
  const witness = Object.freeze({}) as TrustedSourceProofWitness;
  proofs.set(witness, proof);
  return witness;
}

export function trustedSourceProof(witness: TrustedSourceProofWitness): AdmittedSourceProof {
  const proof = proofs.get(witness);
  if (!proof) throw new Error('SOURCE_PROOF_WITNESS_INVALID');
  return structuredClone(proof);
}

export function validateAdmittedSourceProof(value: unknown): AdmittedSourceProof {
  if (!isData(value) || !isData(value.producer)) throw new Error('SOURCE_PROOF_RECORD_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'state',
      'reason',
      'run_id',
      'candidate_sha',
      'base_sha',
      'tree_sha',
      'runtime_sha',
      'plan_digest',
      'verification_profile_id',
      'verification_profile_sha256',
      'producer',
    ],
    [],
    'SOURCE_PROOF_RECORD_INVALID',
  );
  assertExactKeys(
    value.producer,
    [
      'repository_id',
      'repository_full_name',
      'workflow_path',
      'workflow_run_id',
      'workflow_run_attempt',
      'job_id',
    ],
    [],
    'SOURCE_PROOF_RECORD_INVALID',
  );
  if (
    value.schema !== 'overcenter-admitted-source-proof/v2' ||
    value.state !== 'verified' ||
    value.reason !== null ||
    typeof value.producer.workflow_path !== 'string' ||
    !value.producer.workflow_path.startsWith('.github/workflows/') ||
    !isPositiveSafeInteger(value.producer.repository_id) ||
    !isPositiveSafeInteger(value.producer.workflow_run_id) ||
    !isPositiveSafeInteger(value.producer.workflow_run_attempt) ||
    !isPositiveSafeInteger(value.producer.job_id) ||
    typeof value.producer.repository_full_name !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.producer.repository_full_name) ||
    !isSha256Hex(value.plan_digest) ||
    !isSha256Hex(value.verification_profile_sha256)
  )
    throw new Error('SOURCE_PROOF_RECORD_INVALID');
  assertNonEmptyString(value.run_id, 'SOURCE_PROOF_RECORD_INVALID');
  assertNonEmptyString(value.verification_profile_id, 'SOURCE_PROOF_RECORD_INVALID');
  for (const field of [value.candidate_sha, value.base_sha, value.tree_sha, value.runtime_sha])
    exactSha(field);
  return structuredClone(value) as unknown as AdmittedSourceProof;
}
