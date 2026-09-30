import { canonicalDigest } from '../digest.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  isData,
  isPositiveSafeInteger,
  isSha256Hex,
} from '../validation.ts';
import {
  verifyGitHubRepositoryIdentity,
  githubRepositoryPath,
} from '../providers/github/evidence-primitives.ts';
import { githubGet, type GitHubJsonGet } from '../providers/github/rest.ts';
import { observeRepositoryDelta, assertSupportedSourceDelta } from './repository-delta.ts';
import {
  baselineSourceTransactionPlan,
  type SourceTransactionContext,
} from './transaction-baseline.ts';
import {
  sourceTransactionPlanDigest,
  validateSourceTransactionPlan,
  type SourceTransactionPlan,
} from './transaction.ts';

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
const REQUIRED_JOB = 'Verify source candidate / Candidate evidence';
export interface AdmittedSourceProof extends SourceProofRecord {
  artifact: { id: number; digest: string };
}
const proofs = new WeakMap<object, AdmittedSourceProof>();
declare const proofBrand: unique symbol;
export type TrustedSourceProofWitness = { readonly [proofBrand]: true };

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

export function admitSourceProof(
  repo: string,
  planValue: SourceTransactionPlan,
  recordValue: unknown,
  {
    githubToken,
    expectedWorkflowRunId,
    expectedWorkflowRunAttempt,
    context,
    get = githubGet,
  }: {
    githubToken: string;
    expectedWorkflowRunId: number;
    expectedWorkflowRunAttempt: number;
    context: SourceTransactionContext;
    get?: GitHubJsonGet;
  },
): TrustedSourceProofWitness {
  const plan = validateSourceTransactionPlan(planValue);
  if (!isData(recordValue) || !isData(recordValue.producer))
    throw new Error('SOURCE_PROOF_RECORD_INVALID');
  assertExactKeys(
    recordValue,
    [
      'schema',
      'schema_version',
      'state',
      'reason',
      'run_id',
      'candidate_sha',
      'base_sha',
      'tree_sha',
      'runtime_sha',
      'plan_digest',
      'model_sha256',
      'dependency_sha256',
      'baseline_id',
      'baseline_sha256',
      'producer',
    ],
    [],
    'SOURCE_PROOF_RECORD_INVALID',
  );
  assertExactKeys(
    recordValue.producer,
    [
      'repository_id',
      'repository_full_name',
      'workflow_path',
      'workflow_run_id',
      'workflow_run_attempt',
      'job_name',
      'job_id',
    ],
    [],
    'SOURCE_PROOF_PRODUCER_INVALID',
  );
  const expected = sourceProofRecord(
    plan,
    {
      workflow_run_id: expectedWorkflowRunId,
      workflow_run_attempt: expectedWorkflowRunAttempt,
      job_id: Number(recordValue.producer.job_id),
    },
    'success',
  );
  if (canonicalDigest(recordValue) !== canonicalDigest(expected))
    throw new Error('SOURCE_PROOF_BINDING_MISMATCH');
  if (
    context.repository_id !== plan.repository_id ||
    context.repository_full_name !== plan.repository_full_name ||
    context.runtime_sha !== plan.runtime_sha ||
    context.baseline_id !== plan.assurance.baseline_id
  )
    throw new Error('SOURCE_PROOF_CONTEXT_MISMATCH');
  const delta = observeRepositoryDelta(repo, plan.claim.source_sha, plan.candidate_sha);
  assertSupportedSourceDelta(delta);
  if (
    delta.candidate_tree !== plan.candidate_tree ||
    canonicalDigest(delta.entries.map((entry) => entry.path).sort()) !==
      canonicalDigest([...plan.observed_write_set].sort())
  )
    throw new Error('SOURCE_PROOF_SOURCE_MISMATCH');
  const assurance = baselineSourceTransactionPlan(repo, delta, context);
  if (
    canonicalDigest(assurance) !== canonicalDigest(plan.assurance) ||
    assurance.validation_mode !== 'baseline'
  )
    throw new Error('SOURCE_PROOF_BASELINE_MISMATCH');
  verifyGitHubRepositoryIdentity(githubToken, {
    repositoryId: plan.repository_id,
    repositoryFullName: plan.repository_full_name,
    get,
  });
  const api = (suffix: string) =>
    get(githubToken, githubRepositoryPath(plan.repository_full_name, suffix));
  const run = api(`/actions/runs/${expectedWorkflowRunId}`);
  if (
    !isData(run) ||
    run.id !== expectedWorkflowRunId ||
    run.run_attempt !== expectedWorkflowRunAttempt ||
    run.path !== WORKFLOW ||
    run.head_sha !== plan.candidate_sha ||
    run.head_branch !== `overcenter/candidate/${plan.claim.run_id}` ||
    !['push', 'workflow_dispatch'].includes(run.event as string) ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    !isData(run.repository) ||
    run.repository.id !== plan.repository_id ||
    !isData(run.head_repository) ||
    run.head_repository.id !== plan.repository_id
  )
    throw new Error('SOURCE_PROOF_WORKFLOW_INVALID');
  const jobs = api(
    `/actions/runs/${expectedWorkflowRunId}/attempts/${expectedWorkflowRunAttempt}/jobs?per_page=100`,
  );
  if (!isData(jobs) || !Array.isArray(jobs.jobs) || jobs.jobs.length >= 100)
    throw new Error('SOURCE_PROOF_JOBS_INCOMPLETE');
  for (const name of [REQUIRED_JOB, RECORD_JOB]) {
    const matches = jobs.jobs.filter((job) => isData(job) && job.name === name);
    if (
      matches.length !== 1 ||
      !isData(matches[0]) ||
      !isPositiveSafeInteger(matches[0].id) ||
      matches[0].conclusion !== 'success' ||
      matches[0].status !== 'completed' ||
      matches[0].run_id !== expectedWorkflowRunId ||
      matches[0].head_sha !== plan.candidate_sha ||
      (name === RECORD_JOB && matches[0].id !== expected.producer.job_id)
    )
      throw new Error(`SOURCE_PROOF_JOB_INVALID:${name}`);
  }
  const artifacts = api(`/actions/runs/${expectedWorkflowRunId}/artifacts?per_page=100`);
  if (
    !isData(artifacts) ||
    !Array.isArray(artifacts.artifacts) ||
    artifacts.artifacts.length >= 100
  )
    throw new Error('SOURCE_PROOF_ARTIFACTS_INCOMPLETE');
  const matching = artifacts.artifacts.filter(
    (artifact) => isData(artifact) && artifact.name === 'overcenter-source-verification',
  );
  const artifact = matching[0];
  if (
    matching.length !== 1 ||
    !isData(artifact) ||
    !isPositiveSafeInteger(artifact.id) ||
    artifact.expired !== false ||
    typeof artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(artifact.digest) ||
    !isData(artifact.workflow_run) ||
    artifact.workflow_run.id !== expectedWorkflowRunId ||
    artifact.workflow_run.head_sha !== plan.candidate_sha ||
    artifact.workflow_run.repository_id !== plan.repository_id ||
    artifact.workflow_run.head_repository_id !== plan.repository_id
  )
    throw new Error('SOURCE_PROOF_ARTIFACT_INVALID');
  // Every admitted field is independently reconstructed. Serialized artifact contents supply
  // coordinates, never a success assertion; provider job results and immutable source own it.
  const witness = Object.freeze({}) as TrustedSourceProofWitness;
  proofs.set(witness, {
    ...expected,
    artifact: { id: artifact.id as number, digest: artifact.digest },
  });
  return witness;
}

export function trustedSourceProof(witness: TrustedSourceProofWitness): AdmittedSourceProof {
  const proof = proofs.get(witness);
  if (!proof) throw new Error('SOURCE_PROOF_WITNESS_INVALID');
  return validateAdmittedSourceProof(proof);
}

export function validateAdmittedSourceProof(value: unknown): AdmittedSourceProof {
  if (!isData(value) || !isData(value.producer) || !isData(value.artifact))
    throw new Error('SOURCE_PROOF_RECORD_INVALID');
  assertExactKeys(
    value,
    [
      'schema',
      'schema_version',
      'state',
      'reason',
      'run_id',
      'candidate_sha',
      'base_sha',
      'tree_sha',
      'runtime_sha',
      'plan_digest',
      'model_sha256',
      'dependency_sha256',
      'baseline_id',
      'baseline_sha256',
      'producer',
      'artifact',
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
      'job_name',
      'job_id',
    ],
    [],
    'SOURCE_PROOF_PRODUCER_INVALID',
  );
  assertExactKeys(value.artifact, ['id', 'digest'], [], 'SOURCE_PROOF_ARTIFACT_INVALID');
  if (
    value.schema !== 'overcenter-source-verification' ||
    value.schema_version !== 2 ||
    value.state !== 'verified' ||
    value.reason !== null ||
    value.producer.workflow_path !== WORKFLOW ||
    value.producer.job_name !== RECORD_JOB
  )
    throw new Error('SOURCE_PROOF_RECORD_INVALID');
  for (const key of ['run_id', 'baseline_id'])
    assertNonEmptyString(value[key], 'SOURCE_PROOF_RECORD_INVALID');
  for (const key of ['candidate_sha', 'base_sha', 'tree_sha', 'runtime_sha'])
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{40}$/.test(value[key] as string))
      throw new Error('SOURCE_PROOF_RECORD_INVALID');
  for (const key of ['plan_digest', 'model_sha256', 'dependency_sha256', 'baseline_sha256'])
    if (!isSha256Hex(value[key])) throw new Error('SOURCE_PROOF_RECORD_INVALID');
  for (const key of ['repository_id', 'workflow_run_id', 'workflow_run_attempt', 'job_id'])
    if (!isPositiveSafeInteger(value.producer[key]))
      throw new Error('SOURCE_PROOF_PRODUCER_INVALID');
  if (
    typeof value.producer.repository_full_name !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.producer.repository_full_name) ||
    !isPositiveSafeInteger(value.artifact.id) ||
    typeof value.artifact.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.artifact.digest)
  )
    throw new Error('SOURCE_PROOF_ARTIFACT_INVALID');
  return structuredClone(value) as unknown as AdmittedSourceProof;
}
