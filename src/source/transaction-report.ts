import { execFileSync, spawnSync } from 'node:child_process';
import { githubGet, type GitHubJsonGet } from '../providers/github/rest.ts';
import {
  verifyGitHubRepositoryIdentity,
  githubRepositoryPath,
} from '../providers/github/evidence-primitives.ts';
import { isData, isPositiveSafeInteger } from '../validation.ts';
import { canonicalDigest } from '../digest.ts';
import { GitOvercenterKernel } from '../storage/git-kernel.ts';
import { observeRepositoryDelta } from './repository-delta.ts';
import { validateSourceIntegrationEvidence } from './source-integration.ts';

export function reportSourceTransaction(
  repo: string,
  runId: string,
  {
    remote = 'origin',
    authorityRef = 'refs/overcenter/state',
    sourceRef = 'refs/heads/main',
    githubToken = null,
    get = githubGet,
    requireSettled = false,
  }: {
    remote?: string;
    authorityRef?: string;
    sourceRef?: string;
    githubToken?: string | null;
    get?: GitHubJsonGet;
    requireSettled?: boolean;
  } = {},
) {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const authorityHead = new GitOvercenterKernel(repo, { remote, ref: authorityRef }).head();
  if (!authorityHead) throw new Error('SOURCE_TRANSACTION_REPORT_AUTHORITY_MISSING');
  // Pin reconstruction to the fetched authority commit, rather than mixing multiple reads.
  const kernel = new GitOvercenterKernel(repo, { ref: authorityHead });
  const binding = kernel.sourceTransaction(runId);
  if (!binding) throw new Error('SOURCE_TRANSACTION_REPORT_BINDING_MISSING');
  const delta = observeRepositoryDelta(
    repo,
    binding.plan.claim.source_sha,
    binding.plan.candidate_sha,
  );
  if (
    delta.candidate_tree !== binding.plan.candidate_tree ||
    canonicalDigest(delta.entries.map((entry) => entry.path)) !==
      canonicalDigest([...binding.plan.observed_write_set].sort())
  )
    throw new Error('SOURCE_TRANSACTION_REPORT_DELTA_MISMATCH');
  const receipt = kernel.receipts(runId).at(-1);
  const integration =
    receipt?.kind === 'source-integration' && receipt.disposition === 'DONE'
      ? validateSourceIntegrationEvidence(receipt.diagnostic?.source_integration)
      : null;
  const observed = git('ls-remote', remote, sourceRef).split(/\s+/);
  if (
    observed.length !== 2 ||
    observed[1] !== sourceRef ||
    !/^[0-9a-f]{40}$/.test(observed[0] ?? '')
  )
    throw new Error('SOURCE_TRANSACTION_REPORT_SOURCE_UNAVAILABLE');
  const observedSource = observed[0]!;
  git('fetch', '--no-tags', remote, observedSource);
  if (integration) {
    if (
      integration.run_id !== runId ||
      integration.source_sha !== binding.plan.claim.source_sha ||
      integration.candidate_sha !== binding.plan.candidate_sha ||
      integration.verified_tree_sha !== binding.plan.candidate_tree ||
      integration.plan_digest !== binding.plan_digest ||
      integration.verified_tree_sha !==
        git('rev-parse', `${integration.integration_commit}^{tree}`) ||
      (spawnSync(
        'git',
        ['-C', repo, 'merge-base', '--is-ancestor', integration.integration_commit, observedSource],
        { stdio: 'ignore' },
      ).status ?? 1) !== 0
    )
      throw new Error('SOURCE_TRANSACTION_REPORT_INTEGRATION_UNOBSERVED');
  }
  let executedChecks: Array<{
    number: number;
    name: string;
    status: string;
    conclusion: string | null;
  }> | null = null;
  let repositoryIdentity: 'verified' | 'unverified' = 'unverified';
  if (githubToken) {
    verifyGitHubRepositoryIdentity(githubToken, {
      repositoryId: binding.plan.repository_id,
      repositoryFullName: binding.plan.repository_full_name,
      get,
    });
    for (const [ref, sha] of [
      [authorityRef, authorityHead],
      [sourceRef, observedSource],
    ]) {
      if (!ref?.startsWith('refs/')) throw new Error('SOURCE_TRANSACTION_REPORT_REF_INVALID');
      const raw = get(
        githubToken,
        githubRepositoryPath(
          binding.plan.repository_full_name,
          `/git/ref/${ref.slice(5).split('/').map(encodeURIComponent).join('/')}`,
        ),
      );
      if (!isData(raw) || raw.ref !== ref || !isData(raw.object) || raw.object.sha !== sha)
        throw new Error('SOURCE_TRANSACTION_REPORT_REPOSITORY_REF_MISMATCH');
    }
    if (integration?.source_proof) {
      const producer = integration.source_proof.producer;
      const raw = get(
        githubToken,
        githubRepositoryPath(
          binding.plan.repository_full_name,
          `/actions/runs/${producer.workflow_run_id}/attempts/${producer.workflow_run_attempt}/jobs?per_page=100`,
        ),
      );
      if (!isData(raw) || !Array.isArray(raw.jobs) || raw.jobs.length >= 100)
        throw new Error('SOURCE_TRANSACTION_REPORT_JOBS_INVALID');
      const jobs = raw.jobs.filter(
        (job) => isData(job) && job.name === 'Verify source candidate / Candidate evidence',
      );
      const job = jobs[0];
      if (
        jobs.length !== 1 ||
        !isData(job) ||
        !isPositiveSafeInteger(job.id) ||
        job.run_id !== producer.workflow_run_id ||
        job.head_sha !== binding.plan.candidate_sha ||
        job.status !== 'completed' ||
        job.conclusion !== 'success' ||
        !Array.isArray(job.steps) ||
        !job.steps.length
      )
        throw new Error('SOURCE_TRANSACTION_REPORT_CHECKS_UNVERIFIED');
      executedChecks = job.steps.map((step) => {
        if (
          !isData(step) ||
          !isPositiveSafeInteger(step.number) ||
          typeof step.name !== 'string' ||
          typeof step.status !== 'string' ||
          (step.conclusion !== null && typeof step.conclusion !== 'string')
        )
          throw new Error('SOURCE_TRANSACTION_REPORT_CHECKS_INVALID');
        return {
          number: step.number,
          name: step.name,
          status: step.status,
          conclusion: step.conclusion,
        };
      });
      if (new Set(executedChecks.map((step) => step.number)).size !== executedChecks.length)
        throw new Error('SOURCE_TRANSACTION_REPORT_CHECKS_INVALID');
    }
    repositoryIdentity = 'verified';
  }
  const state = kernel.inspect().find((work) => work.run_id === runId)?.status ?? 'HISTORICAL';
  const report = {
    schema: 'overcenter-source-transaction-evidence',
    schema_version: 1,
    repository_identity: repositoryIdentity,
    repository_id: binding.plan.repository_id,
    repository_full_name: binding.plan.repository_full_name,
    runtime_sha: binding.plan.runtime_sha,
    run_id: runId,
    authority_head: authorityHead,
    plan_digest: binding.plan_digest,
    plan_ref: binding.plan_ref,
    planned_write_set: binding.plan.expected_write_set,
    observed_write_set: delta.entries.map((entry) => entry.path),
    candidate_sha: binding.plan.candidate_sha,
    candidate_tree: binding.plan.candidate_tree,
    assurance: binding.plan.assurance,
    validation_executed: integration?.source_proof
      ? {
          workflow_path: integration.source_proof.producer.workflow_path,
          workflow_run_id: integration.source_proof.producer.workflow_run_id,
          workflow_run_attempt: integration.source_proof.producer.workflow_run_attempt,
          required_job: 'Verify source candidate / Candidate evidence',
          observed_steps: executedChecks,
          producer_job_id: integration.source_proof.producer.job_id,
          artifact: integration.source_proof.artifact,
          proof_ref: integration.source_proof_ref,
        }
      : null,
    source_integration: integration,
    independently_observed_source_sha: observedSource,
    reconstructed_state: state,
    authority_settled:
      receipt?.disposition === 'DONE' && receipt.verified === true && integration !== null,
    settled:
      repositoryIdentity === 'verified' &&
      receipt?.disposition === 'DONE' &&
      receipt.verified === true &&
      integration !== null,
    settlement_commit: receipt?.settlement_commit ?? null,
  };
  if (requireSettled && !report.settled)
    throw new Error('SOURCE_TRANSACTION_REPORT_LIFECYCLE_INCOMPLETE');
  return { ...report, report_digest: canonicalDigest(report) };
}
