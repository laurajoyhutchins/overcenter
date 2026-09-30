import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { baselineSourceTransactionPlan } from '../src/source/transaction-baseline.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import {
  sourceTransactionPlanDigest,
  type SourceTransactionPlan,
} from '../src/source/transaction.ts';
import { validateSourceTransactionBindingFact } from '../src/authority/facts.ts';
import { admitSourceProof, trustedSourceProof } from '../src/source/source-proof.ts';
import { sourceProofRecord, type SourceProofRecord } from '../src/source/source-proof-record.ts';

test('source proof admission binds successful provider jobs to immutable plan and trusted baseline', (t) => {
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
  writeFileSync(join(repo, 'value.ts'), 'export const value = 1;');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(repo, 'value.ts'), 'export const value = 2;');
  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  const context = {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
    baseline_id: 'fixture',
    validator_paths: ['baseline.txt', '.github/workflows'],
  };
  const delta = observeRepositoryDelta(repo, base, candidate);
  const plan: SourceTransactionPlan = {
    schema: 'overcenter-source-transaction',
    schema_version: 1,
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: context.runtime_sha,
    claim: {
      run_id: 'source-run',
      obligation_key: 'key',
      claimed_revision: 'authority',
      source_sha: base,
    },
    execution_generation: 1,
    execution_authority_commit: 'authority',
    candidate_sha: candidate,
    candidate_tree: delta.candidate_tree,
    authorized_write_set: ['value.ts'],
    expected_write_set: ['value.ts'],
    observed_write_set: ['value.ts'],
    assurance: baselineSourceTransactionPlan(repo, delta, context),
  };
  const producer = { workflow_run_id: 123, workflow_run_attempt: 2, job_id: 11 };
  const record = sourceProofRecord(plan, producer, 'success');
  const binding = validateSourceTransactionBindingFact({
    schema: 'overcenter-source-transaction-binding',
    schema_version: 1,
    run_id: plan.claim.run_id,
    obligation_id: 'source',
    execution_generation: plan.execution_generation,
    execution_authority_commit: plan.execution_authority_commit,
    plan,
    plan_digest: sourceTransactionPlanDigest(plan),
  });
  const run = {
    id: 123,
    path: '.github/workflows/agent-candidate-signal.yml',
    run_attempt: 2,
    head_sha: candidate,
    head_branch: 'overcenter/candidate/source-run',
    event: 'push',
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
  const artifacts = {
    artifacts: [
      {
        id: 12,
        name: 'overcenter-source-verification',
        expired: false,
        digest: `sha256:${'f'.repeat(64)}`,
        workflow_run: { id: 123, repository_id: 42, head_repository_id: 42, head_sha: candidate },
      },
    ],
  };
  const get = (_token: string, path: string): unknown =>
    path.endsWith('/attempts/2/jobs?per_page=100')
      ? jobs
      : path.endsWith('/artifacts?per_page=100')
        ? artifacts
        : path.endsWith('/actions/runs/123')
          ? run
          : { id: 42, full_name: 'acme/widget' };
  const options = {
    githubToken: 'fixture',
    get,
    expectedWorkflowRunId: 123,
    expectedWorkflowRunAttempt: 2,
    context,
  };
  const witness = admitSourceProof(binding, record, options);
  assert.equal(trustedSourceProof(witness).plan_digest, sourceTransactionPlanDigest(plan));
  assert.throws(() => trustedSourceProof(record as never), /SOURCE_PROOF_WITNESS_INVALID/);
  for (const changed of [
    { plan_digest: '0'.repeat(64) },
    { candidate_sha: base },
    { runtime_sha: 'b'.repeat(40) },
    { baseline_sha256: '0'.repeat(64) },
    { producer: { ...record.producer, workflow_run_attempt: 1 } },
    { state: 'rejected', reason: 'failed' },
  ]) {
    assert.throws(() => admitSourceProof(binding, { ...record, ...changed }, options));
  }
  for (const changed of [
    { head_sha: base },
    { run_attempt: 1 },
    { conclusion: 'failure' },
    { path: '.github/workflows/other.yml' },
    { head_repository: { id: 99 } },
  ]) {
    assert.throws(() =>
      admitSourceProof(binding, record, {
        ...options,
        get: (token, path) =>
          path.endsWith('/actions/runs/123') ? { ...run, ...changed } : get(token, path),
      }),
    );
  }
  for (const conclusion of ['failure', 'skipped', null])
    assert.throws(() =>
      admitSourceProof(binding, record, {
        ...options,
        get: (token, path) =>
          path.endsWith('/attempts/2/jobs?per_page=100')
            ? { jobs: [{ ...jobs.jobs[0], conclusion }, jobs.jobs[1]] }
            : get(token, path),
      }),
    );
  assert.throws(() =>
    admitSourceProof(binding, record, { ...options, expectedWorkflowRunId: 999 }),
  );
  writeFileSync(join(repo, 'baseline.txt'), 'weakened checks');
  git('add', '-A');
  git('commit', '-qm', 'weakened validator');
  const changed = git('rev-parse', 'HEAD');
  assert.equal(
    baselineSourceTransactionPlan(repo, observeRepositoryDelta(repo, base, changed), context)
      .validation_mode,
    'unsupported',
  );
  assert.equal((record as SourceProofRecord).schema_version, 2);
});
