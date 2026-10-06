import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const verifier = resolve('scripts/verify-protected-source-recovery.ts');

function fixture(t: import('node:test').TestContext) {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-protected-recovery-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();

  git('init', '-q');
  git('config', 'user.name', 'Recovery fixture');
  git('config', 'user.email', 'recovery@local');
  mkdirSync(join(repo, '.overcenter'), { recursive: true });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(
    join(repo, '.overcenter/source-verification-profile.json'),
    `${JSON.stringify(
      {
        schema: 'overcenter-source-verification-profile/v1',
        id: 'fixture/v1',
        workflow_path: '.github/workflows/verify.yml',
        required_evidence_jobs: ['Verify source candidate / Candidate evidence'],
        record_job: 'Record source verification',
        commands: ['npm run lint', 'npm run typecheck', 'npm run test:unit'],
        protected_paths: ['.github', '.overcenter', 'scripts'],
        baseline_test_roots: ['test'],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(repo, 'scripts/target.ts'), 'export const value = 1;\n');
  writeFileSync(join(repo, 'scripts/verify-source-profile.ts'), 'export const root = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { repo, git, base: git('rev-parse', 'HEAD') };
}

function authorize(
  repo: string,
  base: string,
  candidate: string,
  tree: string,
  writablePaths: string[],
  authorizedBy = 'owner',
): string {
  const path = join(repo, 'authorization.json');
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schema: 'overcenter-protected-source-recovery-authorization/v1',
        repository_full_name: 'owner/repo',
        base_sha: base,
        candidate_sha: candidate,
        candidate_tree_sha: tree,
        writable_paths: writablePaths,
        reason: 'repair accepted verifier',
        authorized_by: authorizedBy,
      },
      null,
      2,
    )}\n`,
  );
  return path;
}

function verify(
  repo: string,
  authorization: string,
  base: string,
  actor = 'owner',
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--experimental-strip-types', verifier, authorization, repo], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_REPOSITORY_OWNER: 'owner',
      GITHUB_ACTOR: actor,
      ACCEPTED_BASE_SHA: base,
    },
  });
}

test('accepts the exact owner-authorized protected transition', (t) => {
  const { repo, git, base } = fixture(t);
  writeFileSync(join(repo, 'scripts/target.ts'), 'export const value = 2;\n');
  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', `${candidate}^{tree}`);
  const authorization = authorize(repo, base, candidate, tree, ['scripts/target.ts']);

  const result = verify(repo, authorization, base);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.base_sha, base);
  assert.equal(receipt.candidate_sha, candidate);
  assert.deepEqual(receipt.writable_paths, ['scripts/target.ts']);
  assert.match(receipt.authorization_sha256, /^[0-9a-f]{64}$/);
});

test('rejects authorization by anyone other than the repository owner', (t) => {
  const { repo, git, base } = fixture(t);
  writeFileSync(join(repo, 'scripts/target.ts'), 'export const value = 2;\n');
  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', `${candidate}^{tree}`);
  const authorization = authorize(repo, base, candidate, tree, ['scripts/target.ts'], 'intruder');

  const result = verify(repo, authorization, base, 'intruder');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PROTECTED_SOURCE_RECOVERY_OWNER_AUTHORIZATION_REQUIRED/);
});

test('rejects write-set drift and unprotected paths', (t) => {
  const { repo, git, base } = fixture(t);
  writeFileSync(join(repo, 'notes.txt'), 'not protected\n');
  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', `${candidate}^{tree}`);

  const mismatch = verify(
    repo,
    authorize(repo, base, candidate, tree, ['scripts/target.ts']),
    base,
  );
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /PROTECTED_SOURCE_RECOVERY_WRITE_SET_MISMATCH/);

  const unprotected = verify(repo, authorize(repo, base, candidate, tree, ['notes.txt']), base);
  assert.notEqual(unprotected.status, 0);
  assert.match(unprotected.stderr, /PROTECTED_SOURCE_RECOVERY_UNPROTECTED_PATH:notes\.txt/);
});

test('rejects recovery-root mutation', (t) => {
  const { repo, git, base } = fixture(t);
  writeFileSync(join(repo, 'scripts/verify-source-profile.ts'), 'export const root = 2;\n');
  git('add', '-A');
  git('commit', '-qm', 'candidate');
  const candidate = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', `${candidate}^{tree}`);
  const authorization = authorize(repo, base, candidate, tree, [
    'scripts/verify-source-profile.ts',
  ]);

  const result = verify(repo, authorization, base);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /PROTECTED_SOURCE_RECOVERY_ROOT_PATH:scripts\/verify-source-profile\.ts/,
  );
});

test('rejects a candidate that is not the direct child of the accepted base', (t) => {
  const { repo, git, base } = fixture(t);
  writeFileSync(join(repo, 'scripts/target.ts'), 'export const value = 2;\n');
  git('add', '-A');
  git('commit', '-qm', 'first candidate');
  writeFileSync(join(repo, 'scripts/target.ts'), 'export const value = 3;\n');
  git('add', '-A');
  git('commit', '-qm', 'second candidate');
  const candidate = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', `${candidate}^{tree}`);
  const authorization = authorize(repo, base, candidate, tree, ['scripts/target.ts']);

  const result = verify(repo, authorization, base);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PROTECTED_SOURCE_RECOVERY_DIRECT_CHILD_REQUIRED/);
});
