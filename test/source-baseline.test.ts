import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  baselineSourceTransactionPlan,
  sourceTransactionContextFromEnvironment,
} from '../src/source/transaction-baseline.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import { ARCHITECTURE_SQL_PATHS } from '../src/architecture/sql-model.ts';

test('baseline identity includes validator modes and every declared architecture model input', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-source-baseline-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Baseline');
  git('config', 'user.email', 'baseline@local');
  mkdirSync(join(repo, 'architecture'));
  for (const path of ARCHITECTURE_SQL_PATHS) writeFileSync(join(repo, path), '-- base model');
  writeFileSync(join(repo, 'validator.sh'), 'true\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const context = {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
    baseline_id: 'fixture',
    validator_paths: ['validator.sh'],
  };
  const initial = baselineSourceTransactionPlan(
    repo,
    observeRepositoryDelta(repo, base, base),
    context,
  );
  for (const path of ARCHITECTURE_SQL_PATHS) {
    git('reset', '--hard', base);
    writeFileSync(join(repo, path), '-- candidate model');
    git('add', '-A');
    git('commit', '-qm', 'changed model');
    const candidate = git('rev-parse', 'HEAD');
    const plan = baselineSourceTransactionPlan(
      repo,
      observeRepositoryDelta(repo, base, candidate),
      context,
    );
    assert.notEqual(plan.model_sha256, initial.model_sha256);
    assert.equal(plan.validation_mode, 'unsupported');
    assert.ok(plan.coverage_gaps.some((gap) => gap.reason === 'model-changed'));
  }
  git('reset', '--hard', base);
  chmodSync(join(repo, 'validator.sh'), 0o755);
  git('add', '-A');
  git('commit', '-qm', 'validator mode change');
  const mode = baselineSourceTransactionPlan(
    repo,
    observeRepositoryDelta(repo, base, git('rev-parse', 'HEAD')),
    context,
  );
  assert.equal(mode.baseline_sha256, initial.baseline_sha256);
  assert.ok(mode.coverage_gaps.some((gap) => gap.reason === 'validator-changed'));
  assert.equal(mode.validation_mode, 'unsupported');
});

test('trusted repository policy freezes the proof evaluator and model closure', () => {
  const context = sourceTransactionContextFromEnvironment({
    GITHUB_REPOSITORY: 'laurajoyhutchins/overcenter',
    GITHUB_REPOSITORY_ID: '42',
    OVERCENTER_RUNTIME_SHA: 'a'.repeat(40),
  });
  for (const path of [
    'src/analysis',
    'src/architecture',
    'src/repository',
    'src/execution',
    'architecture',
    'tcb-policy.json',
    'src/effect-adapter.ts',
    'src/digest.ts',
    'src/validation.ts',
    'contracts',
  ])
    assert.ok(context.validator_paths.includes(path));
});

test('external policy freezes canonical evidence producers, inputs and Python version', () => {
  const context = sourceTransactionContextFromEnvironment({
    GITHUB_REPOSITORY: 'laurajoyhutchins/azelficoast',
    GITHUB_REPOSITORY_ID: '43',
    OVERCENTER_RUNTIME_SHA: 'a'.repeat(40),
  });
  for (const path of [
    '.python-version',
    'src/azelficoast/research/evidence.py',
    'experiments/evidence',
  ])
    assert.ok(context.validator_paths.includes(path));
});
