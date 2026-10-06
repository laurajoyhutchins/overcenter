import { assertExactKeys, assertNonEmptyString, isData, isPositiveSafeInteger } from '../validation.ts';

export const SOURCE_PROOF_OBSERVATION_SCHEMA =
  'overcenter-source-proof-observation/v1' as const;

export interface SourceProofObservedJob {
  id: number;
  run_id: number;
  head_sha: string;
  name: string;
  status: string;
  conclusion: string | null;
}

export interface SourceProofObservation {
  schema: typeof SOURCE_PROOF_OBSERVATION_SCHEMA;
  provider: 'github';
  repository_id: number;
  repository_full_name: string;
  workflow_run: {
    id: number;
    run_attempt: number;
    path: string;
    head_sha: string;
    head_branch: string;
    event: string;
    status: string;
    conclusion: string | null;
    repository_id: number;
    head_repository_id: number;
  };
  jobs: SourceProofObservedJob[];
}

function exactSha(value: unknown, error: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(error);
}

export function validateSourceProofObservation(value: unknown): SourceProofObservation {
  if (!isData(value) || !isData(value.workflow_run) || !Array.isArray(value.jobs)) {
    throw new Error('SOURCE_PROOF_OBSERVATION_INVALID');
  }
  assertExactKeys(
    value,
    ['schema', 'provider', 'repository_id', 'repository_full_name', 'workflow_run', 'jobs'],
    [],
    'SOURCE_PROOF_OBSERVATION_INVALID',
  );
  assertExactKeys(
    value.workflow_run,
    [
      'id',
      'run_attempt',
      'path',
      'head_sha',
      'head_branch',
      'event',
      'status',
      'conclusion',
      'repository_id',
      'head_repository_id',
    ],
    [],
    'SOURCE_PROOF_OBSERVATION_INVALID',
  );
  if (
    value.schema !== SOURCE_PROOF_OBSERVATION_SCHEMA ||
    value.provider !== 'github' ||
    !isPositiveSafeInteger(value.repository_id) ||
    !isPositiveSafeInteger(value.workflow_run.id) ||
    !isPositiveSafeInteger(value.workflow_run.run_attempt) ||
    !isPositiveSafeInteger(value.workflow_run.repository_id) ||
    !isPositiveSafeInteger(value.workflow_run.head_repository_id) ||
    typeof value.repository_full_name !== 'string' ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository_full_name)
  ) {
    throw new Error('SOURCE_PROOF_OBSERVATION_INVALID');
  }
  assertNonEmptyString(value.workflow_run.path, 'SOURCE_PROOF_OBSERVATION_INVALID');
  assertNonEmptyString(value.workflow_run.head_branch, 'SOURCE_PROOF_OBSERVATION_INVALID');
  assertNonEmptyString(value.workflow_run.event, 'SOURCE_PROOF_OBSERVATION_INVALID');
  assertNonEmptyString(value.workflow_run.status, 'SOURCE_PROOF_OBSERVATION_INVALID');
  exactSha(value.workflow_run.head_sha, 'SOURCE_PROOF_OBSERVATION_INVALID');
  if (value.workflow_run.conclusion !== null && typeof value.workflow_run.conclusion !== 'string') {
    throw new Error('SOURCE_PROOF_OBSERVATION_INVALID');
  }

  const jobs = value.jobs.map((job) => {
    if (!isData(job)) throw new Error('SOURCE_PROOF_OBSERVATION_INVALID');
    assertExactKeys(
      job,
      ['id', 'run_id', 'head_sha', 'name', 'status', 'conclusion'],
      [],
      'SOURCE_PROOF_OBSERVATION_INVALID',
    );
    if (
      !isPositiveSafeInteger(job.id) ||
      !isPositiveSafeInteger(job.run_id)
    ) {
      throw new Error('SOURCE_PROOF_OBSERVATION_INVALID');
    }
    exactSha(job.head_sha, 'SOURCE_PROOF_OBSERVATION_INVALID');
    assertNonEmptyString(job.name, 'SOURCE_PROOF_OBSERVATION_INVALID');
    assertNonEmptyString(job.status, 'SOURCE_PROOF_OBSERVATION_INVALID');
    if (job.conclusion !== null && typeof job.conclusion !== 'string') {
      throw new Error('SOURCE_PROOF_OBSERVATION_INVALID');
    }
    return {
      id: job.id,
      run_id: job.run_id,
      head_sha: job.head_sha,
      name: job.name,
      status: job.status,
      conclusion: job.conclusion,
    };
  });

  return {
    schema: SOURCE_PROOF_OBSERVATION_SCHEMA,
    provider: 'github',
    repository_id: value.repository_id,
    repository_full_name: value.repository_full_name,
    workflow_run: {
      id: value.workflow_run.id,
      run_attempt: value.workflow_run.run_attempt,
      path: value.workflow_run.path,
      head_sha: value.workflow_run.head_sha,
      head_branch: value.workflow_run.head_branch,
      event: value.workflow_run.event,
      status: value.workflow_run.status,
      conclusion: value.workflow_run.conclusion,
      repository_id: value.workflow_run.repository_id,
      head_repository_id: value.workflow_run.head_repository_id,
    },
    jobs,
  };
}
