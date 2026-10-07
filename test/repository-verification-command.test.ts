import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deriveAssuranceEvidenceRecipe,
  executionEvidenceRealizationFromRecipeObservation,
  observeAssuranceEvidenceRecipe,
} from '../src/execution/assurance-evidence-realization.ts';
import { deriveAssuranceEvidenceNeeds } from '../src/source/assurance-evidence-needs.ts';
import {
  sourceVerificationRecipeStep,
  validateSourceVerificationProfile,
} from '../src/source/source-verification-profile.ts';
import type { TransactionAssurancePlan } from '../src/source/transaction-planner.ts';

function fixture(t: import('node:test').TestContext) {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-repository-command-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Repository command');
  git('config', 'user.email', 'repository-command@local');
  mkdirSync(join(repo, '.overcenter'), { recursive: true });
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  mkdirSync(join(repo, 'tools'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/evidence.yml'), 'name: evidence\n');
  writeFileSync(join(repo, 'tools/check.mjs'), "process.exitCode = 0;\n");
  const profile = {
    schema: 'overcenter-source-verification-profile/v1',
    id: 'fixture-command/v1',
    workflow_path: '.github/workflows/evidence.yml',
    required_evidence_jobs: ['Evidence / Candidate'],
    record_job: 'Record evidence',
    commands: ['node tools/check.mjs'],
    protected_paths: ['.github', '.overcenter', 'tools/check.mjs'],
    baseline_test_roots: ['tools'],
  };
  writeFileSync(
    join(repo, '.overcenter/source-verification-profile.json'),
    `${JSON.stringify(profile, null, 2)}\n`,
  );
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  return { repo, revision: git('rev-parse', 'HEAD'), profile };
}

function baselineNeed(revision: string, profile: ReturnType<typeof validateSourceVerificationProfile>) {
  const evidenceId = `baseline:${profile.id}`;
  const plan: TransactionAssurancePlan = {
    base_revision: revision,
    candidate_revision: revision,
    candidate_tree: 'c'.repeat(40),
    model_sha256: '1'.repeat(64),
    dependency_sha256: '2'.repeat(64),
    changed_artifacts: ['value.txt'],
    impacts: [],
    proof_plans: [],
    evidence: [],
    evidence_frontiers: [
      {
        coordinate: `revision:${revision}`,
        revision,
        model_sha256: '1'.repeat(64),
        dependency_sha256: '2'.repeat(64),
        baseline_sha256: '3'.repeat(64),
        required_propositions: [evidenceId],
        candidates: [
          {
            evidence_id: evidenceId,
            proposition_ids: [evidenceId],
            obligation_ids: [],
            artifact_ids: [],
            package_scripts: profile.commands.map(sourceVerificationRecipeStep),
            uses_package_runtime: false,
          },
        ],
      },
    ],
    coverage_gaps: [],
    validation_mode: 'baseline',
    baseline_id: profile.id,
    baseline_sha256: '3'.repeat(64),
  };
  return deriveAssuranceEvidenceNeeds(plan)[0]!;
}

test('repository-owned argv verification runs without package.json or a shell', (t) => {
  const { repo, revision, profile: raw } = fixture(t);
  const profile = validateSourceVerificationProfile(raw);
  const need = baselineNeed(revision, profile);
  const recipe = deriveAssuranceEvidenceRecipe(repo, need);
  assert.deepEqual(recipe.scripts, ['argv:["node","tools/check.mjs"]']);

  const observation = observeAssuranceEvidenceRecipe(repo, recipe);
  assert.deepEqual(observation.attempts, [
    { script: 'argv:["node","tools/check.mjs"]', exit_code: 0 },
  ]);
  assert.equal(
    executionEvidenceRealizationFromRecipeObservation(recipe, observation).semantic_evidence
      .realization_kind,
    'repository-commands/v1',
  );
});

test('profile rejects shell syntax and a forged baseline recipe cannot select another command', (t) => {
  const { repo, revision, profile: raw } = fixture(t);
  assert.throws(
    () => validateSourceVerificationProfile({ ...raw, commands: ['node tools/check.mjs && echo no'] }),
    /SOURCE_VERIFICATION_PROFILE_COMMANDS_INVALID/,
  );

  const profile = validateSourceVerificationProfile(raw);
  const need = baselineNeed(revision, profile);
  const forged = {
    ...need,
    inputs: {
      ...need.inputs,
      package_scripts: '["argv:[\\\"node\\\",\\\"tools/other.mjs\\\"]"]',
    },
  };
  assert.throws(
    () => deriveAssuranceEvidenceRecipe(repo, forged),
    /ASSURANCE_EVIDENCE_NEED_ID_MISMATCH/,
  );
});
