import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import {
  admitSourceProof,
  SourceProofRejected,
  trustedSourceProof,
} from '../src/source/source-proof.ts';
import { sourceProofRecord, type SourceProofRecord } from '../src/source/source-proof-record.ts';
import {
  buildSourceTransactionPlan,
  sourceTransactionPlanDigest,
} from '../src/source/transaction.ts';
import { baselineSourceTransactionPlan } from '../src/source/transaction-baseline.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import { verifyGitHubSourceProofObservation } from '../src/source/github-source-proof-observation.ts';
import { readSourceVerificationProfile } from '../src/source/source-verification-profile.ts';

test('GitHub source proof observation boundary fails closed on incomplete or ambiguous evidence', () => {
  const expected = {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    workflow_path: '.github/workflows/agent-candidate-signal.yml',
    workflow_run_id: 123,
    workflow_run_attempt: 2,
    candidate_sha: 'a'.repeat(40),
    candidate_branch: 'overcenter/candidate/source-run',
    required_evidence_jobs: ['Verify source candidate / Candidate evidence'],
    record_job: 'Record source verification',
    record_job_id: 11,
    rejected: false,
  };
  const run = {
    id: 123,
    path: expected.workflow_path,
    run_attempt: 2,
    head_sha: expected.candidate_sha,
    head_branch: expected.candidate_branch,
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    repository: { id: 42 },
    head_repository: { id: 42 },
  };
  const evidenceJob = {
    id: 10,
    status: 'completed',
    run_id: 123,
    head_sha: expected.candidate_sha,
    name: expected.required_evidence_jobs[0],
    conclusion: 'success',
  };
  const recordJob = {
    id: 11,
    status: 'completed',
    run_id: 123,
    head_sha: expected.candidate_sha,
    name: expected.record_job,
    conclusion: 'success',
  };
  const read = (jobs: unknown) => (_token: string, path: string): unknown =>
    path.endsWith('/actions/runs/123') ? run : jobs;

  assert.doesNotThrow(() =>
    verifyGitHubSourceProofObservation('fixture', expected, read({ jobs: [evidenceJob, recordJob] })),
  );
  assert.throws(
    () =>
      verifyGitHubSourceProofObservation(
        'fixture',
        expected,
        read({ jobs: [evidenceJob, { ...evidenceJob, id: 12 }, recordJob] }),
      ),
    /SOURCE_PROOF_JOB_INVALID/,
  );
  assert.throws(
    () =>
      verifyGitHubSourceProofObservation(
        'fixture',
        expected,
        read({
          jobs: Array.from({ length: 100 }, (_, index) => ({
            ...evidenceJob,
            id: index + 1,
          })),
        }),
      ),
    /SOURCE_PROOF_JOBS_INCOMPLETE/,
  );
  assert.throws(
    () =>
      verifyGitHubSourceProofObservation(
        'fixture',
        { ...expected, record_job_id: 99 },
        read({ jobs: [evidenceJob, recordJob] }),
      ),
    /SOURCE_PROOF_JOB_INVALID/,
  );
});

test('source proof admission binds provider jobs to reconstructed plan and trusted baseline', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-source-proof-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Proof');
  git('config', 'user.email', 'proof@local');
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/agent-candidate-signal.yml'), 'trusted producer');
  writeFileSync(join(repo, 'baseline.txt'), 'independent checks');
  mkdirSync(join(repo, '.overcenter'), { recursive: true });
  writeFileSync(
    join(repo, '.overcenter/source-verification-profile.json'),
    `${JSON.stringify(
      {
        schema: 'overcenter-source-verification-profile/v1',
        id: 'fixture',
        workflow_path: '.github/workflows/agent-candidate-signal.yml',
        required_evidence_jobs: ['Verify source candidate / Candidate evidence'],
        record_job: 'Record source verification',
        commands: ['npm run lint', 'npm run typecheck', 'npm run test:unit'],
        protected_paths: ['.github', '.overcenter', 'baseline.txt'],
        baseline_test_roots: ['test'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repo, 'value.ts'), 'export const value = 1;');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  const context = {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
  };
  writeFileSync(join(repo, 'value.ts'), 'export const value = 2;');
  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  const claim = {
    run_id: 'source-run',
    obligation_key: 'key',
    claimed_revision: 'authority',
    source_sha: base,
  };
  const task = {
    schema: 'overcenter-source-task/v1',
    kind: 'source-change',
    objective: 'Update value',
    writable_paths: ['value.ts'],
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
  };
  const plan = buildSourceTransactionPlan({
    repo,
    taskValue: task,
    claim,
    candidateSha: candidate,
    context,
  });
  const producer = { workflow_run_id: 123, workflow_run_attempt: 2, job_id: 11 };
  const record = sourceProofRecord(plan, producer, 'success');
  assert.equal(record.verification_profile_id, plan.verification_profile.profile.id);
  assert.equal(record.verification_profile_sha256, plan.verification_profile.sha256);
  const run = {
    id: 123,
    path: '.github/workflows/agent-candidate-signal.yml',
    run_attempt: 2,
    head_sha: candidate,
    head_branch: 'overcenter/candidate/source-run',
    event: 'workflow_dispatch',
    status: 'completed',
    conclusion: 'success',
    repository: { id: 42 },
    head_repository: { id: 42 },
  };
  const jobs = {
    jobs: [
      {
        id: 10,
        status: 'completed',
        run_id: 123,
        head_sha: candidate,
        name: 'Verify source candidate / Candidate evidence',
        conclusion: 'success',
      },
      {
        id: 11,
        status: 'completed',
        run_id: 123,
        head_sha: candidate,
        name: 'Record source verification',
        conclusion: 'success',
      },
    ],
  };
  const get = (_token: string, path: string): unknown =>
    path.endsWith('/attempts/2/jobs?per_page=100')
      ? jobs
      : path.endsWith('/actions/runs/123')
        ? run
        : { id: 42, full_name: 'acme/widget' };
  const options = {
    githubToken: 'fixture',
    get,
    expectedWorkflowRunId: 123,
    expectedWorkflowRunAttempt: 2,
    context: {
      ...context,
      verification_profile_id: plan.verification_profile.profile.id,
      verification_profile_sha256: plan.verification_profile.sha256,
    },
  };
  const witness = admitSourceProof(plan, record, options);
  assert.equal(trustedSourceProof(witness).plan_digest, sourceTransactionPlanDigest(plan));
  assert.throws(() => trustedSourceProof(record as never), /SOURCE_PROOF_WITNESS_INVALID/);

  const rejectedRecord = sourceProofRecord(plan, producer, 'failure');
  assert.throws(
    () =>
      admitSourceProof(plan, rejectedRecord, {
        ...options,
        get: (token, path) => {
          if (path.endsWith('/actions/runs/123')) return { ...run, conclusion: 'failure' };
          if (path.endsWith('/attempts/2/jobs?per_page=100'))
            return {
              jobs: [{ ...jobs.jobs[0], conclusion: 'failure' }, jobs.jobs[1]],
            };
          return get(token, path);
        },
      }),
    SourceProofRejected,
  );

  for (const changed of [
    { plan_digest: '0'.repeat(64) },
    { verification_profile_sha256: '0'.repeat(64) },
    { candidate_sha: base },
    { runtime_sha: 'b'.repeat(40) },
    { baseline_sha256: '0'.repeat(64) },
    { producer: { ...record.producer, workflow_run_attempt: 1 } },
    { state: 'rejected', reason: 'failed' },
  ]) {
    assert.throws(() => admitSourceProof(plan, { ...record, ...changed }, options));
  }
  for (const changed of [
    { head_sha: base },
    { run_attempt: 1 },
    { conclusion: 'failure' },
    { path: '.github/workflows/other.yml' },
    { head_repository: { id: 99 } },
  ]) {
    assert.throws(() =>
      admitSourceProof(plan, record, {
        ...options,
        get: (token, path) =>
          path.endsWith('/actions/runs/123') ? { ...run, ...changed } : get(token, path),
      }),
    );
  }
  for (const conclusion of ['failure', 'skipped', null]) {
    assert.throws(() =>
      admitSourceProof(plan, record, {
        ...options,
        get: (token, path) =>
          path.endsWith('/attempts/2/jobs?per_page=100')
            ? { jobs: [{ ...jobs.jobs[0], conclusion }, jobs.jobs[1]] }
            : get(token, path),
      }),
    );
  }
  assert.throws(() => admitSourceProof(plan, record, { ...options, expectedWorkflowRunId: 999 }));

  writeFileSync(join(repo, 'baseline.txt'), 'weakened checks');
  git('add', '-A');
  git('commit', '-qm', 'weakened validator');
  const changed = git('rev-parse', 'HEAD');
  assert.equal(
    baselineSourceTransactionPlan(
      repo,
      observeRepositoryDelta(repo, base, changed),
      readSourceVerificationProfile(repo, base).profile,
    ).validation_mode,
    'unsupported',
  );
  assert.equal((record as SourceProofRecord).schema_version, 3);
});
