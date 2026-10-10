import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareSitePublication } from '../examples/site/prepare-publication.ts';
import {
  admitSourceProofEvidence,
  type TrustedSourceProofWitness,
} from '../src/source/source-proof-admission.ts';
import { buildSourceTransactionPlan } from '../src/source/transaction.ts';
import { executionEvidenceReceipt } from '../src/execution/evidence-receipt.ts';
import {
  sourceProofExecutionEvidenceDescriptor,
  sourceProofExecutionEvidenceRealization,
} from '../src/source/source-proof-evidence.ts';

test('preparation binds reproducible source and output and rejects a forged proof', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pages-prepare-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'source');
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  await mkdir(join(repo, '.overcenter'));
  await mkdir(join(repo, '.github/workflows'), { recursive: true });
  await writeFile(join(repo, '.github/workflows/verify.yml'), 'trusted verifier');
  await writeFile(
    join(repo, '.overcenter/source-verification-profile.json'),
    JSON.stringify({
      schema: 'overcenter-source-verification-profile/v1',
      id: 'fixture',
      workflow_path: '.github/workflows/verify.yml',
      required_evidence_jobs: ['verify'],
      record_job: 'record',
      commands: ['npm run lint', 'npm run typecheck', 'npm run test:unit'],
      protected_paths: ['.github', '.overcenter'],
      baseline_test_roots: ['test'],
    }),
  );
  await writeFile(join(repo, 'content.txt'), 'abc');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(repo, 'content.txt'), 'def');
  git('add', '.');
  git('commit', '-qm', 'candidate');
  const source = git('rev-parse', 'HEAD');
  const context = {
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
  };
  const plan = buildSourceTransactionPlan({
    repo,
    candidateSha: source,
    context,
    taskValue: {
      schema: 'overcenter-source-task/v1',
      kind: 'source-change',
      objective: 'Update content',
      writable_paths: ['content.txt'],
      effect_contract: 'github-source/integrate-verified-tree/v1',
    },
    claim: {
      run_id: 'source-run',
      obligation_key: 'source-key',
      claimed_revision: 'authority',
      source_sha: base,
    },
  });
  const descriptor = sourceProofExecutionEvidenceDescriptor(plan);
  const proof = admitSourceProofEvidence(plan, {
    executionEvidence: executionEvidenceReceipt(
      descriptor,
      sourceProofExecutionEvidenceRealization(plan, 'satisfied'),
    ),
    context: {
      ...context,
      verification_profile_id: plan.verification_profile.profile.id,
      verification_profile_sha256: plan.verification_profile.sha256,
    },
  });
  let builds = 0;
  const options = {
    source_repo: repo,
    scratch_root: root,
    source_plan: plan,
    source_proof: proof,
    source_ref: 'refs/heads/main',
    destination_ref: 'refs/heads/gh-pages',
    expected_head_sha: null,
    site_base_url: 'https://acme.github.io/widget/',
    limits: { max_files: 10, max_total_bytes: 100, max_observation_calls: 40 },
    commit_metadata: {
      author_name: 'Publisher',
      author_email: 'publisher@example.test',
      timestamp: '2026-10-07T00:00:00Z',
    },
  } as const;
  // Trusted fixture builder replaces only the physically unavailable confinement transport.
  const runBuild = async (workspace: string) => {
    builds++;
    const out = join(workspace, '.overcenter-build/site');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'index.html'), await readFile(join(workspace, 'content.txt')));
    await writeFile(join(out, '.nojekyll'), '');
  };
  const first = await prepareSitePublication(options, { runBuild });
  const second = await prepareSitePublication(options, { runBuild });
  assert.equal(first.publication_sha, second.publication_sha);
  assert.equal(first.publication_tree_sha, second.publication_tree_sha);
  assert.equal(
    first.manifest.files[1]?.sha256,
    'cb8379ac2098aa165029e3938a51da0bcecfc008fd6795f401178647f96c5b34',
  );
  assert.equal(builds, 4);
  await assert.rejects(
    prepareSitePublication(
      { ...options, source_proof: {} as TrustedSourceProofWitness },
      { runBuild },
    ),
    /SOURCE_PROOF_WITNESS_INVALID/,
  );
  await assert.rejects(
    prepareSitePublication(
      { ...options, source_plan: { ...plan, candidate_tree: 'b'.repeat(40) } },
      { runBuild },
    ),
  );
  assert.equal(builds, 4);
  await assert.rejects(
    prepareSitePublication(options, {
      runBuild: async (workspace) => {
        await runBuild(workspace);
        await writeFile(join(workspace, '.overcenter-build/site/index.html'), String(builds));
      },
    }),
    /PAGES_BUILD_NOT_REPRODUCIBLE/,
  );
});
