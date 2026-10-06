import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import {
  buildSourceTransactionPlan,
  sourceTransactionPlanDigest,
  validateSourceTransactionPlan,
  validateSourceTransactionTask,
  type SourceTransactionPlan,
} from '../src/source/transaction.ts';
import { sourceVerificationProfileBinding } from '../src/source/source-verification-profile.ts';

const profile = {
  schema: 'overcenter-source-verification-profile/v1' as const,
  id: 'repository-baseline',
  workflow_path: '.github/workflows/verify.yml',
  required_evidence_jobs: ['Verify candidate / Candidate evidence'],
  record_job: 'Record source verification',
  commands: ['npm run test:unit'],
  protected_paths: ['.github', '.overcenter'],
  baseline_test_roots: ['test'],
};

function plan(): SourceTransactionPlan {
  return {
    schema: 'overcenter-source-transaction',
    schema_version: 2,
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
    claim: {
      obligation_key: 'key',
      run_id: 'run',
      claimed_revision: 'revision',
      source_sha: 'b'.repeat(40),
    },
    candidate_sha: 'c'.repeat(40),
    candidate_tree: 'd'.repeat(40),
    verification_profile: { profile, sha256: sourceVerificationProfileBinding(profile).sha256 },
    write_envelope: {
      allowed_roots: [],
      exact_paths: ['extra.ts', 'value.ts'],
      denied_roots: [],
      denied_paths: [],
      max_changed_files: null,
      max_changed_bytes: null,
    },
    authorized_write_set: ['value.ts', 'extra.ts'],
    expected_write_set: ['value.ts'],
    observed_write_set: ['value.ts'],
    observed_write_bytes: 12,
    assurance: {
      base_revision: 'b'.repeat(40),
      candidate_revision: 'c'.repeat(40),
      candidate_tree: 'd'.repeat(40),
      model_sha256: 'e'.repeat(64),
      dependency_sha256: 'f'.repeat(64),
      baseline_id: 'repository-baseline',
      baseline_sha256: '1'.repeat(64),
      coverage_gaps: [{ artifact_id: 'value.ts', reason: 'unmodeled-artifact' }],
      validation_mode: 'baseline',
      changed_artifacts: ['value.ts'],
      impacts: [],
      proof_plans: [],
      evidence: [],
      evidence_frontiers: [
        {
          coordinate: `revision:${'c'.repeat(40)}`,
          revision: 'c'.repeat(40),
          model_sha256: 'e'.repeat(64),
          dependency_sha256: 'f'.repeat(64),
          baseline_sha256: '1'.repeat(64),
          required_propositions: ['baseline:repository-baseline'],
          candidates: [
            {
              evidence_id: 'baseline:repository-baseline',
              proposition_ids: ['baseline:repository-baseline'],
              obligation_ids: [],
              artifact_ids: [],
              package_scripts: ['test:unit'],
              uses_package_runtime: true,
            },
          ],
        },
      ],
    },
  };
}

test('transaction plans reject missing, extra, and unauthorized writes', () => {
  assert.throws(
    () => validateSourceTransactionPlan({ ...plan(), observed_write_set: [] }),
    /SOURCE_TRANSACTION_DIVERGED/,
  );
  assert.throws(
    () =>
      validateSourceTransactionPlan({ ...plan(), observed_write_set: ['value.ts', 'extra.ts'] }),
    /SOURCE_TRANSACTION_DIVERGED/,
  );
  assert.throws(
    () =>
      validateSourceTransactionPlan({
        ...plan(),
        expected_write_set: ['outside.ts'],
        observed_write_set: ['outside.ts'],
      }),
    /SOURCE_TRANSACTION_SCOPE/,
  );
  assert.throws(
    () => validateSourceTransactionPlan({ ...plan(), unexpected: true }),
    /SOURCE_TRANSACTION_INVALID/,
  );
});

test('transaction identity covers repository, candidate, and baseline policy', () => {
  const original = sourceTransactionPlanDigest(plan());
  assert.notEqual(sourceTransactionPlanDigest({ ...plan(), repository_id: 43 }), original);
  const changedBaseline = '2'.repeat(64);
  const changed = plan();
  changed.assurance = {
    ...changed.assurance,
    baseline_sha256: changedBaseline,
    evidence_frontiers: changed.assurance.evidence_frontiers.map((frontier) =>
      frontier.revision === changed.assurance.candidate_revision
        ? { ...frontier, baseline_sha256: changedBaseline }
        : frontier,
    ),
  };
  assert.notEqual(sourceTransactionPlanDigest(changed), original);
});

test('transaction plan is reconstructed from immutable candidate and runtime binding', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-transaction-plan-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Transaction');
  git('config', 'user.email', 'transaction@local');
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
  writeFileSync(join(repo, 'value.ts'), 'export const value = 1;\n');
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'test/known.test.ts'), 'assert.ok(true);\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  const context = {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
  };
  writeFileSync(join(repo, 'value.ts'), 'export const value = 2;\n');
  writeFileSync(join(repo, 'test/new.test.ts'), 'assert.ok(false);\n');
  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  const claim = {
    obligation_key: 'key',
    run_id: 'source-run',
    claimed_revision: 'authority',
    source_sha: base,
  };
  const task = {
    schema: 'overcenter-source-task/v1',
    kind: 'source-change',
    objective: 'Update value',
    writable_paths: [],
    write_envelope: {
      allowed_roots: ['.'],
      exact_paths: [],
      denied_roots: ['.git'],
      denied_paths: ['README.md'],
      max_changed_files: 2,
      max_changed_bytes: 100,
    },
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
  };

  const first = buildSourceTransactionPlan({
    repo,
    taskValue: task,
    claim,
    candidateSha: candidate,
    context,
  });
  const second = buildSourceTransactionPlan({
    repo,
    taskValue: task,
    claim,
    candidateSha: candidate,
    context,
  });
  assert.deepEqual(second, first);
  assert.deepEqual(first.expected_write_set, ['test/new.test.ts', 'value.ts']);
  assert.deepEqual(first.observed_write_set, ['test/new.test.ts', 'value.ts']);
  assert.equal(first.verification_profile.profile.id, 'fixture');
  assert.match(first.verification_profile.sha256, /^[0-9a-f]{64}$/);
  validateSourceTransactionTask(first, task);
  assert.throws(
    () =>
      buildSourceTransactionPlan({
        repo,
        taskValue: {
          ...task,
          writable_paths: [],
          write_envelope: {
            ...task.write_envelope,
            allowed_roots: ['src'],
          },
        },
        claim,
        candidateSha: candidate,
        context,
      }),
    /SOURCE_PROPOSAL_SCOPE_VIOLATION/,
  );
  const alternateRuntime = buildSourceTransactionPlan({
    repo,
    taskValue: task,
    claim,
    candidateSha: candidate,
    context: { ...context, runtime_sha: 'b'.repeat(40) },
  });
  assert.notEqual(
    sourceTransactionPlanDigest(alternateRuntime),
    sourceTransactionPlanDigest(first),
  );
  assert.throws(
    () =>
      validateSourceTransactionTask(first, {
        ...task,
        writable_paths: [],
        write_envelope: { ...task.write_envelope, allowed_roots: ['other'] },
      }),
    /SOURCE_TRANSACTION_TASK_MISMATCH/,
  );
});
