import type { SourceTransactionBindingFact } from '../authority/facts.ts';
import type { GitHubJsonGet } from '../providers/github/rest.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  isData,
  isPositiveSafeInteger,
  isSha256Hex,
} from '../validation.ts';
import type { AdmittedSourceProof, SourceProofContext } from './source-proof-record.ts';
export type { AdmittedSourceProof } from './source-proof-record.ts';

const WORKFLOW = '.github/workflows/agent-candidate-signal.yml';
const RECORD_JOB = 'Record source verification';
const REQUIRED_JOB = 'Verify source candidate / Candidate evidence';

const proofs = new WeakMap<object, AdmittedSourceProof>();
declare const sourceProofBrand: unique symbol;
export type TrustedSourceProofWitness = { readonly [sourceProofBrand]: true };

function exactSha(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))
    throw new Error('SOURCE_PROOF_BINDING_MISMATCH');
}

function repositoryPath(repositoryFullName: string, suffix: string): string {
  const [owner, name, ...extra] = repositoryFullName.split('/');
  if (!owner || !name || extra.length) throw new Error('SOURCE_PROOF_REPOSITORY_INVALID');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

export function admitSourceProof(
  binding: SourceTransactionBindingFact,
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
    get: GitHubJsonGet;
  },
): TrustedSourceProofWitness {
  if (!isData(recordValue) || !isData(recordValue.producer) || !isData(binding.plan.assurance))
    throw new Error('SOURCE_PROOF_RECORD_INVALID');
  const producer = recordValue.producer;
  const assurance = binding.plan.assurance;
  if (
    recordValue.schema !== 'overcenter-source-verification' ||
    recordValue.schema_version !== 2 ||
    recordValue.state !== 'verified' ||
    recordValue.reason !== null ||
    recordValue.run_id !== binding.run_id ||
    recordValue.candidate_sha !== binding.plan.candidate_sha ||
    recordValue.base_sha !== binding.plan.claim.source_sha ||
    recordValue.runtime_sha !== binding.plan.runtime_sha ||
    recordValue.plan_digest !== binding.plan_digest ||
    recordValue.model_sha256 !== assurance.model_sha256 ||
    recordValue.dependency_sha256 !== assurance.dependency_sha256 ||
    recordValue.baseline_id !== assurance.baseline_id ||
    recordValue.baseline_sha256 !== assurance.baseline_sha256 ||
    context.repository_id !== binding.plan.repository_id ||
    context.repository_full_name !== binding.plan.repository_full_name ||
    context.runtime_sha !== binding.plan.runtime_sha ||
    context.baseline_id !== assurance.baseline_id
  )
    throw new Error('SOURCE_PROOF_BINDING_MISMATCH');
  exactSha(recordValue.tree_sha);
  if (
    producer.repository_id !== binding.plan.repository_id ||
    producer.repository_full_name !== binding.plan.repository_full_name ||
    producer.workflow_path !== WORKFLOW ||
    producer.workflow_run_id !== expectedWorkflowRunId ||
    producer.workflow_run_attempt !== expectedWorkflowRunAttempt ||
    producer.job_name !== RECORD_JOB ||
    !isPositiveSafeInteger(producer.job_id) ||
    !isPositiveSafeInteger(expectedWorkflowRunId) ||
    !isPositiveSafeInteger(expectedWorkflowRunAttempt)
  )
    throw new Error('SOURCE_PROOF_PRODUCER_INVALID');

  const api = (suffix: string) =>
    get(githubToken, repositoryPath(binding.plan.repository_full_name, suffix));
  const run = api(`/actions/runs/${expectedWorkflowRunId}`);
  if (
    !isData(run) ||
    run.id !== expectedWorkflowRunId ||
    run.run_attempt !== expectedWorkflowRunAttempt ||
    run.path !== WORKFLOW ||
    run.head_sha !== binding.plan.candidate_sha ||
    run.head_branch !== `overcenter/candidate/${binding.run_id}` ||
    !['push', 'workflow_dispatch'].includes(run.event as string) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !isData(run.repository) ||
    run.repository.id !== binding.plan.repository_id ||
    !isData(run.head_repository) ||
    run.head_repository.id !== binding.plan.repository_id
  )
    throw new Error('SOURCE_PROOF_WORKFLOW_INVALID');

  const jobs = api(
    `/actions/runs/${expectedWorkflowRunId}/attempts/${expectedWorkflowRunAttempt}/jobs?per_page=100`,
  );
  if (!isData(jobs) || !Array.isArray(jobs.jobs) || jobs.jobs.length >= 100)
    throw new Error('SOURCE_PROOF_JOBS_INCOMPLETE');
  for (const name of [REQUIRED_JOB, RECORD_JOB]) {
    const matches = jobs.jobs.filter((job) => isData(job) && job.name === name);
    const job = matches[0];
    if (
      matches.length !== 1 ||
      !isData(job) ||
      !isPositiveSafeInteger(job.id) ||
      job.run_id !== expectedWorkflowRunId ||
      job.head_sha !== binding.plan.candidate_sha ||
      job.status !== 'completed' ||
      job.conclusion !== 'success' ||
      (name === RECORD_JOB && job.id !== producer.job_id)
    )
      throw new Error(`SOURCE_PROOF_JOB_INVALID:${name}`);
  }

  const proof = validateAdmittedSourceProof({
    schema: 'overcenter-admitted-source-proof/v1',
    state: 'verified',
    reason: null,
    run_id: binding.run_id,
    candidate_sha: binding.plan.candidate_sha,
    base_sha: binding.plan.claim.source_sha,
    tree_sha: recordValue.tree_sha,
    runtime_sha: binding.plan.runtime_sha,
    plan_digest: binding.plan_digest,
    producer: {
      repository_id: binding.plan.repository_id,
      repository_full_name: binding.plan.repository_full_name,
      workflow_path: WORKFLOW,
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
    value.schema !== 'overcenter-admitted-source-proof/v1' ||
    value.state !== 'verified' ||
    value.reason !== null ||
    value.producer.workflow_path !== WORKFLOW ||
    !isPositiveSafeInteger(value.producer.repository_id) ||
    !isPositiveSafeInteger(value.producer.workflow_run_id) ||
    !isPositiveSafeInteger(value.producer.workflow_run_attempt) ||
    !isPositiveSafeInteger(value.producer.job_id) ||
    typeof value.producer.repository_full_name !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.producer.repository_full_name) ||
    !isSha256Hex(value.plan_digest)
  )
    throw new Error('SOURCE_PROOF_RECORD_INVALID');
  assertNonEmptyString(value.run_id, 'SOURCE_PROOF_RECORD_INVALID');
  for (const field of [value.candidate_sha, value.base_sha, value.tree_sha, value.runtime_sha])
    exactSha(field);
  return structuredClone(value) as unknown as AdmittedSourceProof;
}
