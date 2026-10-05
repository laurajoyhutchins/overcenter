import { isData, isPositiveSafeInteger } from '../validation.ts';

export interface GitHubSourceProofObservationExpectation {
  repository_id: number;
  repository_full_name: string;
  workflow_path: string;
  workflow_run_id: number;
  workflow_run_attempt: number;
  candidate_sha: string;
  candidate_branch: string;
  required_evidence_jobs: readonly string[];
  record_job: string;
  record_job_id: number;
  rejected: boolean;
}

function repositoryPath(repositoryFullName: string, suffix: string): string {
  const [owner, name, ...extra] = repositoryFullName.split('/');
  if (!owner || !name || extra.length) throw new Error('SOURCE_PROOF_REPOSITORY_INVALID');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

export function verifyGitHubSourceProofObservation(
  token: string,
  expected: GitHubSourceProofObservationExpectation,
  get: (token: string, path: string) => unknown,
): void {
  const api = (suffix: string) => get(token, repositoryPath(expected.repository_full_name, suffix));
  const run = api(`/actions/runs/${expected.workflow_run_id}`);
  if (
    !isData(run) ||
    run.id !== expected.workflow_run_id ||
    run.run_attempt !== expected.workflow_run_attempt ||
    run.path !== expected.workflow_path ||
    run.head_sha !== expected.candidate_sha ||
    run.head_branch !== expected.candidate_branch ||
    run.event !== 'workflow_dispatch' ||
    run.status !== 'completed' ||
    run.conclusion !== (expected.rejected ? 'failure' : 'success') ||
    !isData(run.repository) ||
    run.repository.id !== expected.repository_id ||
    !isData(run.head_repository) ||
    run.head_repository.id !== expected.repository_id
  )
    throw new Error('SOURCE_PROOF_WORKFLOW_INVALID');

  const jobs = api(
    `/actions/runs/${expected.workflow_run_id}/attempts/${expected.workflow_run_attempt}/jobs?per_page=100`,
  );
  if (!isData(jobs) || !Array.isArray(jobs.jobs) || jobs.jobs.length >= 100)
    throw new Error('SOURCE_PROOF_JOBS_INCOMPLETE');

  for (const name of [...expected.required_evidence_jobs, expected.record_job]) {
    const matches = jobs.jobs.filter((job) => isData(job) && job.name === name);
    const job = matches[0];
    if (
      matches.length !== 1 ||
      !isData(job) ||
      !isPositiveSafeInteger(job.id) ||
      job.run_id !== expected.workflow_run_id ||
      job.head_sha !== expected.candidate_sha ||
      job.status !== 'completed' ||
      job.conclusion !==
        (name !== expected.record_job && expected.rejected ? 'failure' : 'success') ||
      (name === expected.record_job && job.id !== expected.record_job_id)
    )
      throw new Error(`SOURCE_PROOF_JOB_INVALID:${name}`);
  }
}
