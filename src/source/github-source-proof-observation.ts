import { projectResponseSlice, type ResponseFieldSpec } from '../observation/response-slice.ts';
import { githubRepositoryCoordinate } from '../providers/github/certified-repository.ts';
import { observeCertifiedGitHubRead200 } from '../providers/github/certified-observation.ts';
import {
  GITHUB_WORKFLOW_JOBS_OPERATION,
  GITHUB_WORKFLOW_RUN_OPERATION,
} from '../providers/github/operations.generated.ts';
import {
  materializeGitHubOperationRequest,
  type GitHubObservationOperation,
} from '../providers/github/openapi.ts';
import type { GitHubJsonGet } from '../providers/github/rest.ts';
import { GITHUB_OPERATION_SEMANTICS } from '../providers/github/semantics.ts';
import { isData } from '../validation.ts';
import {
  SOURCE_PROOF_OBSERVATION_SCHEMA,
  validateSourceProofObservation,
  type SourceProofObservation,
} from './source-proof-observation.ts';

const SOURCE_PROOF_RUN_PATHS = new Set([
  'id',
  'run_attempt',
  'path',
  'head_sha',
  'head_branch',
  'event',
  'status',
  'conclusion',
]);

const SOURCE_PROOF_RUN_FIELDS = GITHUB_OPERATION_SEMANTICS.workflow_run.response_slice.filter(
  (field) => SOURCE_PROOF_RUN_PATHS.has(field.path),
);

const SOURCE_PROOF_JOB_PATHS = new Set([
  'jobs[].id',
  'jobs[].run_id',
  'jobs[].head_sha',
  'jobs[].name',
  'jobs[].status',
  'jobs[].conclusion',
]);

const SOURCE_PROOF_JOB_FIELDS = GITHUB_OPERATION_SEMANTICS.workflow_jobs.response_slice.filter(
  (field) => SOURCE_PROOF_JOB_PATHS.has(field.path),
);

function attemptJobsOperation(): GitHubObservationOperation {
  return {
    ...GITHUB_WORKFLOW_JOBS_OPERATION,
    path_template: GITHUB_WORKFLOW_JOBS_OPERATION.path_template.replace(
      '/jobs',
      '/attempts/{attempt_number}/jobs',
    ),
    operation_id: 'actions/list-jobs-for-workflow-run-attempt',
    parameters: [
      ...GITHUB_WORKFLOW_JOBS_OPERATION.parameters.filter(
        (parameter) => parameter.name !== 'filter',
      ),
      {
        name: 'attempt_number',
        in: 'path',
        required: true,
        schema: { type: 'integer' },
      },
    ],
  };
}

function observeProjection({
  token,
  repositoryFullName,
  operation,
  parameters,
  fields,
  get,
  clock,
}: {
  token: string;
  repositoryFullName: string;
  operation: GitHubObservationOperation;
  parameters: Record<string, string | number | boolean>;
  fields: readonly ResponseFieldSpec[];
  get: GitHubJsonGet;
  clock: () => string;
}): { raw: unknown; projected: unknown } {
  const { owner, repo } = githubRepositoryCoordinate(repositoryFullName);
  const request = materializeGitHubOperationRequest(operation, {
    owner,
    repo,
    ...parameters,
  });
  const { certified } = observeCertifiedGitHubRead200({
    token,
    operation,
    request,
    fields,
    get,
    clock,
    observerId: 'github-source-proof-observation/v1',
  });
  return {
    raw: certified.outcome.value,
    projected: projectResponseSlice(certified.outcome.value, fields),
  };
}

export function observeGitHubSourceProof(
  token: string,
  {
    repositoryId,
    repositoryFullName,
    workflowRunId,
    workflowRunAttempt,
    get,
    clock = () => new Date().toISOString(),
  }: {
    repositoryId: number;
    repositoryFullName: string;
    workflowRunId: number;
    workflowRunAttempt: number;
    get: GitHubJsonGet;
    clock?: () => string;
  },
): SourceProofObservation {
  const runRead = observeProjection({
    token,
    repositoryFullName,
    operation: GITHUB_WORKFLOW_RUN_OPERATION,
    parameters: { run_id: workflowRunId },
    fields: SOURCE_PROOF_RUN_FIELDS,
    get,
    clock,
  });
  const jobsRead = observeProjection({
    token,
    repositoryFullName,
    operation: attemptJobsOperation(),
    parameters: {
      run_id: workflowRunId,
      attempt_number: workflowRunAttempt,
      per_page: 100,
    },
    fields: SOURCE_PROOF_JOB_FIELDS,
    get,
    clock,
  });

  const run = runRead.projected;
  const rawRun = runRead.raw;
  const jobsValue = jobsRead.projected;
  if (
    !isData(run) ||
    !isData(rawRun) ||
    !isData(rawRun.repository) ||
    !isData(rawRun.head_repository) ||
    !isData(jobsValue) ||
    !Array.isArray(jobsValue.jobs) ||
    jobsValue.jobs.length >= 100
  ) {
    throw new Error('SOURCE_PROOF_OBSERVATION_INCOMPLETE');
  }

  return validateSourceProofObservation({
    schema: SOURCE_PROOF_OBSERVATION_SCHEMA,
    provider: 'github',
    repository_id: repositoryId,
    repository_full_name: repositoryFullName,
    workflow_run: {
      id: run.id,
      run_attempt: run.run_attempt,
      path: run.path,
      head_sha: run.head_sha,
      head_branch: run.head_branch,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      repository_id: rawRun.repository.id,
      head_repository_id: rawRun.head_repository.id,
    },
    jobs: jobsValue.jobs,
  });
}
