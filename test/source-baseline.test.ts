import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  baselineSourceTransactionPlan,
  sourceTransactionContextFromEnvironment,
} from '../src/source/transaction-baseline.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import { ARCHITECTURE_SQL_PATHS } from '../src/architecture/sql-model.ts';
import {
  readSourceVerificationProfile,
  validateSourceVerificationProfile,
} from '../src/source/source-verification-profile.ts';

const profile = {
  schema: 'overcenter-source-verification-profile/v1',
  id: 'fixture-profile/v1',
  workflow_path: '.github/workflows/evidence.yml',
  required_evidence_jobs: ['Evidence / Candidate'],
  record_job: 'Record evidence',
  commands: ['npm run lint', 'npm run typecheck', 'npm run test:unit'],
  protected_paths: ['.github', '.overcenter', 'architecture', 'validator.sh'],
  baseline_test_roots: ['test'],
};

test('baseline identity includes profile protected artifacts and every declared architecture model input', (t) => {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-source-baseline-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Baseline');
  git('config', 'user.email', 'baseline@local');
  mkdirSync(join(repo, 'architecture'));
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  mkdirSync(join(repo, '.overcenter'), { recursive: true });
  for (const path of ARCHITECTURE_SQL_PATHS) writeFileSync(join(repo, path), '-- base model');
  writeFileSync(join(repo, '.github/workflows/evidence.yml'), 'workflow\n');
  writeFileSync(
    join(repo, '.overcenter/source-verification-profile.json'),
    `${JSON.stringify(profile)}\n`,
  );
  writeFileSync(join(repo, 'validator.sh'), 'true\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const loaded = readSourceVerificationProfile(repo, base).profile;
  const initial = baselineSourceTransactionPlan(
    repo,
    observeRepositoryDelta(repo, base, base),
    loaded,
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
      loaded,
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
    loaded,
  );
  assert.equal(mode.baseline_sha256, initial.baseline_sha256);
  assert.ok(mode.coverage_gaps.some((gap) => gap.reason === 'validator-changed'));
  assert.equal(mode.validation_mode, 'unsupported');
});

test('repository verification policy is owned by the committed profile, not runtime defaults', () => {
  const context = sourceTransactionContextFromEnvironment({
    GITHUB_REPOSITORY: 'laurajoyhutchins/overcenter',
    GITHUB_REPOSITORY_ID: '42',
    OVERCENTER_RUNTIME_SHA: 'a'.repeat(40),
  });
  assert.deepEqual(Object.keys(context).sort(), [
    'repository_full_name',
    'repository_id',
    'runtime_sha',
  ]);
  const loaded = validateSourceVerificationProfile(
    JSON.parse(readFileSync('.overcenter/source-verification-profile.json', 'utf8')),
  );
  for (const path of [
    '.github',
    '.overcenter',
    'scripts',
    'src/analysis',
    'src/source',
    'src/architecture',
    'src/repository',
    'src/execution',
    'architecture',
    'tcb-policy.json',
    'contracts',
    'package.json',
  ])
    assert.ok(loaded.protected_paths.includes(path));
  assert.deepEqual(loaded.baseline_test_roots, [
    'experiments/production-criticality-ranking',
    'experiments/semantic-scaling',
    'test',
  ]);
});
