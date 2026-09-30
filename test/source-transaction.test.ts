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

function plan(): SourceTransactionPlan {
  return {
    schema: 'overcenter-source-transaction',
    schema_version: 1,
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
    authorized_write_set: ['value.ts', 'extra.ts'],
    expected_write_set: ['value.ts'],
    observed_write_set: ['value.ts'],
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
  assert.notEqual(
    sourceTransactionPlanDigest({
      ...plan(),
      assurance: { ...plan().assurance, baseline_sha256: '2'.repeat(64) },
    }),
    original,
  );
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
  writeFileSync(join(repo, 'value.ts'), 'export const value = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');

  const context = {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
    baseline_id: 'fixture',
    validator_paths: ['baseline.txt', '.github/workflows'],
  };
  writeFileSync(join(repo, 'value.ts'), 'export const value = 2;\n');
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
    writable_paths: ['value.ts'],
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
  assert.deepEqual(first.observed_write_set, ['value.ts']);
  validateSourceTransactionTask(first, task);
  assert.throws(
    () =>
      buildSourceTransactionPlan({
        repo,
        taskValue: { ...task, writable_paths: ['value.ts', 'extra.ts'] },
        claim,
        candidateSha: candidate,
        context,
      }),
    /SOURCE_TRANSACTION_DIVERGED/,
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
    () => validateSourceTransactionTask(first, { ...task, writable_paths: ['other.ts'] }),
    /SOURCE_TRANSACTION_TASK_MISMATCH/,
  );
});
