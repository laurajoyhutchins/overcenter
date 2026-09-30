import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

import { assertSupportedSourceDelta, observeRepositoryDelta } from '../src/source/repository-delta.ts';
import { planSourceTransaction } from '../src/source/transaction-planner.ts';
import { GOLDEN_TRANSACTION_CASE } from './fixtures/golden-transaction.ts';

function fixture(t: TestContext, real = false) {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-planner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  if (real)
    execFileSync('git', ['clone', '--quiet', '--shared', resolve('.'), root], { stdio: 'pipe' });
  else git('init', '-q');
  git('config', 'user.name', 'Planner regression');
  git('config', 'user.email', 'planner@local');
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = () => {
    git('add', '-A');
    git('commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  return { root, git, put, commit };
}

const baseline = {
  baseline_id: 'repository-checks',
  baseline_sha256: 'a'.repeat(64),
  validator_artifacts: ['src/source/transaction-planner.ts'],
};

test('generic repository delta preserves source candidate path observation', (t) => {
  const { root, git, put, commit } = fixture(t);
  put('edit.ts', 'before\n');
  put('remove.ts', 'remove\n');
  const base = commit();

  put('edit.ts', 'after\n');
  rmSync(join(root, 'remove.ts'));
  put('add.ts', 'add\n');
  git('update-index', '--chmod=+x', 'edit.ts');
  const head = commit();

  const delta = observeRepositoryDelta(root, base, head);
  assertSupportedSourceDelta(delta);
  const legacyPaths = execFileSync(
    'git',
    [
      '-C',
      root,
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '--no-renames',
      '-r',
      '-z',
      base,
      head,
    ],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .sort();

  assert.deepEqual(
    delta.entries.map((entry) => entry.path),
    legacyPaths,
  );
});

test('Python changes require a declared baseline and retain explicit coverage gaps', (t) => {
  const { root, put, commit } = fixture(t);
  put('feature.py', 'value = 1\n');
  const base = commit();
  put('feature.py', 'value = 2\n');
  const head = commit();
  const delta = observeRepositoryDelta(root, base, head);
  const plan = planSourceTransaction(root, delta, baseline);
  assert.equal(plan.validation_mode, 'baseline');
  assert.deepEqual(plan.changed_artifacts, ['feature.py']);
  assert.ok(
    plan.coverage_gaps.some(
      (gap) => gap.artifact_id === 'feature.py' && gap.reason === 'unsupported-language',
    ),
  );
  assert.equal(plan.baseline_id, 'repository-checks');
  assert.equal(
    planSourceTransaction(root, delta, { ...baseline, baseline_id: null, baseline_sha256: null })
      .validation_mode,
    'unsupported',
  );
});

test('golden source edit derives the existing impacts and minimum model evidence', (t) => {
  const { root, git, put, commit } = fixture(t, true);
  const golden = GOLDEN_TRANSACTION_CASE;
  const base = git('rev-parse', 'HEAD');
  const before = readFileSync(join(root, golden.candidate.path), 'utf8');
  assert.ok(before.includes(golden.candidate.before));
  put(golden.candidate.path, before.replace(golden.candidate.before, golden.candidate.after));
  const head = commit();
  const plan = planSourceTransaction(root, observeRepositoryDelta(root, base, head), baseline);
  assert.deepEqual(plan.impacts, [
    {
      property_id: 'broker-mutation-safety',
      changed_artifacts: [golden.candidate.path],
      direct: true,
      via_properties: [],
    },
    {
      property_id: 'github-commit-status-provider',
      changed_artifacts: [golden.candidate.path],
      direct: true,
      via_properties: ['broker-mutation-safety'],
    },
    {
      property_id: 'no-false-done',
      changed_artifacts: [golden.candidate.path],
      direct: true,
      via_properties: [],
    },
  ]);
  assert.deepEqual(plan.evidence, golden.expected_minimum_evidence);
  assert.equal(plan.validation_mode, 'baseline');
  assert.deepEqual(plan.coverage_gaps, [
    { artifact_id: golden.candidate.path, reason: 'unresolved-dependency' },
  ]);
});

test('architecture changes cannot erase their own proof requirements', (t) => {
  const { root, git, put, commit } = fixture(t, true);
  const base = git('rev-parse', 'HEAD');
  put('architecture/logic.sql', '-- removed architecture\n');
  const head = commit();
  const plan = planSourceTransaction(root, observeRepositoryDelta(root, base, head), baseline);
  assert.equal(plan.validation_mode, 'unsupported');
  assert.ok(plan.impacts.some((impact) => impact.property_id === 'broker-mutation-safety'));
  assert.ok(plan.coverage_gaps.some((gap) => gap.reason === 'model-changed'));
});

test('dirty workspace source never changes immutable transaction planning', (t) => {
  const { root, git, put, commit } = fixture(t, true);
  const base = git('rev-parse', 'HEAD');
  put('unmodeled.ts', 'export const value = 1;\n');
  const head = commit();
  const delta = observeRepositoryDelta(root, base, head);
  const before = planSourceTransaction(root, delta, baseline);
  put('architecture/logic.sql', 'THIS IS NOT SQL');
  put('unmodeled.ts', 'workspace contamination');
  assert.deepEqual(planSourceTransaction(root, delta, baseline), before);
  assert.equal(before.validation_mode, 'baseline');
  assert.ok(before.coverage_gaps.some((gap) => gap.reason === 'unmodeled-artifact'));
});

test('removing an import cannot erase base-snapshot assurance impact', (t) => {
  const { root, put, commit } = fixture(t, true);
  const path = GOLDEN_TRANSACTION_CASE.candidate.path;
  const original = readFileSync(join(root, path), 'utf8');
  put('src/providers/github/planner-dependency.ts', 'export const dependency = 1;\n');
  put(path, `import './planner-dependency.ts';\n${original}`);
  const base = commit();
  put(path, original);
  put('src/providers/github/planner-dependency.ts', 'export const dependency = 2;\n');
  const head = commit();
  const plan = planSourceTransaction(root, observeRepositoryDelta(root, base, head), baseline);
  assert.ok(
    plan.impacts.some(
      (impact) =>
        impact.property_id === 'github-commit-status-provider' &&
        impact.changed_artifacts.includes('src/providers/github/planner-dependency.ts'),
    ),
  );
  assert.notEqual(plan.validation_mode, 'unsupported');
});

test('deleting a trust root retains base requirements and fails selective coverage', (t) => {
  const { root, git, commit } = fixture(t, true);
  const base = git('rev-parse', 'HEAD');
  const path = GOLDEN_TRANSACTION_CASE.candidate.path;
  rmSync(join(root, path));
  const head = commit();
  const plan = planSourceTransaction(root, observeRepositoryDelta(root, base, head), baseline);
  assert.ok(plan.impacts.some((impact) => impact.property_id === 'github-commit-status-provider'));
  assert.equal(plan.validation_mode, 'baseline');
  assert.ok(
    plan.coverage_gaps.some(
      (gap) => gap.reason === 'source-unavailable' || gap.reason === 'unresolved-dependency',
    ),
  );
});

test('type-only dependency edits change the dependency fingerprint and require baseline coverage', (t) => {
  const { root, put, commit } = fixture(t, true);
  const path = GOLDEN_TRANSACTION_CASE.candidate.path;
  const original = readFileSync(join(root, path), 'utf8');
  put('src/providers/github/planner-types.ts', 'export type PlannerType = string;\n');
  put(path, `import type { PlannerType } from './planner-types.ts';\n${original}`);
  const base = commit();
  put('src/providers/github/planner-types.ts', 'export type PlannerType = number;\n');
  const head = commit();
  const plan = planSourceTransaction(root, observeRepositoryDelta(root, base, head), baseline);
  assert.equal(plan.validation_mode, 'baseline');
  assert.ok(
    plan.coverage_gaps.some((gap) => gap.artifact_id === 'src/providers/github/planner-types.ts'),
  );
  const prior = planSourceTransaction(root, observeRepositoryDelta(root, base, base), baseline);
  assert.notEqual(plan.dependency_sha256, prior.dependency_sha256);
  for (const artifact of plan.changed_artifacts) {
    assert.ok(
      plan.impacts.some((impact) => impact.changed_artifacts.includes(artifact)) ||
        plan.coverage_gaps.some((gap) => gap.artifact_id === artifact),
    );
  }
});
