import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  observeSourceBaseline,
  baselineSourceTransactionPlan,
  sourceTransactionContextFromEnvironment,
} from '../src/source/transaction-baseline.ts';
import { observeRepositoryDelta } from '../src/source/repository-delta.ts';
import { deriveAssuranceEvidenceNeeds } from '../src/source/assurance-evidence-needs.ts';
import {
  deriveAssuranceEvidenceRecipe,
  observeAssuranceEvidenceRecipe,
  executionEvidenceReceiptFromRecipeObservation,
} from '../src/execution/assurance-evidence-realization.ts';
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

function baselineFixture(t: test.TestContext, commands: string[]) {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-command-baseline-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Baseline');
  git('config', 'user.email', 'baseline@local');
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  mkdirSync(join(repo, '.overcenter'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/evidence.yml'), 'workflow\n');
  const value = validateSourceVerificationProfile({
    ...profile,
    commands,
    protected_paths: ['.github', '.overcenter', 'contracts'],
  });
  writeFileSync(join(repo, '.overcenter/source-verification-profile.json'), JSON.stringify(value));
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { repo, git, base: git('rev-parse', 'HEAD'), profile: value };
}

test('absent protected roots are bound and cannot be resurrected by a source candidate', (t) => {
  const f = baselineFixture(t, ['npm run lint']);
  const initial = observeSourceBaseline(f.repo, f.base, f.profile);
  mkdirSync(join(f.repo, 'contracts'));
  writeFileSync(join(f.repo, 'contracts/new.ts'), 'export {};');
  f.git('add', '-A');
  f.git('commit', '-qm', 'resurrect protected root');
  const candidate = f.git('rev-parse', 'HEAD');
  assert.notEqual(observeSourceBaseline(f.repo, candidate, f.profile).digest, initial.digest);
  assert.equal(
    baselineSourceTransactionPlan(
      f.repo,
      observeRepositoryDelta(f.repo, f.base, candidate),
      f.profile,
    ).validation_mode,
    'unsupported',
  );
  assert.throws(() => observeSourceBaseline(f.repo, 'f'.repeat(40), f.profile));
});

test('Python baseline commands produce bound command evidence rather than fictitious npm scripts', (t) => {
  const f = baselineFixture(t, ['python tools/check.py']);
  const plan = baselineSourceTransactionPlan(
    f.repo,
    observeRepositoryDelta(f.repo, f.base, f.base),
    f.profile,
  );
  const evidence = plan.evidence_frontiers[0]!.candidates[0]!;
  assert.deepEqual(evidence.package_scripts, []);
  assert.equal(evidence.uses_package_runtime, false);
  assert.deepEqual(
    (evidence as unknown as { verification_commands: string[] }).verification_commands,
    ['python tools/check.py'],
  );
});

test('Python command evidence executes the exact bound profile and refuses substituted commands', (t) => {
  const f = baselineFixture(t, ['python tools/check.py']);
  mkdirSync(join(f.repo, 'tools'));
  writeFileSync(join(f.repo, 'tools/check.py'), 'raise SystemExit(0)\n');
  f.git('add', '-A');
  f.git('commit', '-qm', 'verifier');
  const revision = f.git('rev-parse', 'HEAD');
  const plan = baselineSourceTransactionPlan(
    f.repo,
    observeRepositoryDelta(f.repo, revision, revision),
    f.profile,
  );
  const need = deriveAssuranceEvidenceNeeds(plan)[0]!;
  assert.equal(need.schema, 'overcenter-assurance-evidence-need/v2');
  const recipe = deriveAssuranceEvidenceRecipe(f.repo, need);
  const observation = observeAssuranceEvidenceRecipe(f.repo, recipe);
  assert.equal(
    executionEvidenceReceiptFromRecipeObservation(recipe, observation).observation.result,
    'satisfied',
  );
  assert.throws(() =>
    observeAssuranceEvidenceRecipe(f.repo, { ...recipe, scripts: ['python malicious.py'] }),
  );
  assert.throws(() =>
    deriveAssuranceEvidenceRecipe(f.repo, {
      ...need,
      inputs: { ...need.inputs, verification_commands: '["python malicious.py"]' },
    }),
  );
  writeFileSync(join(f.repo, 'tools/check.py'), 'raise SystemExit(1)\n');
  assert.throws(
    () => observeAssuranceEvidenceRecipe(f.repo, recipe),
    /ASSURANCE_EVIDENCE_CHECKOUT_DIRTY/,
  );
  f.git('add', '-A');
  f.git('commit', '-qm', 'failing verifier');
  const failedRevision = f.git('rev-parse', 'HEAD');
  const failedPlan = baselineSourceTransactionPlan(
    f.repo,
    observeRepositoryDelta(f.repo, failedRevision, failedRevision),
    f.profile,
  );
  const failedRecipe = deriveAssuranceEvidenceRecipe(
    f.repo,
    deriveAssuranceEvidenceNeeds(failedPlan)[0]!,
  );
  const failed = observeAssuranceEvidenceRecipe(f.repo, failedRecipe);
  assert.equal(
    executionEvidenceReceiptFromRecipeObservation(failedRecipe, failed).observation.result,
    'unsatisfied',
  );
});
