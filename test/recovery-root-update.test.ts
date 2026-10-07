import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const verifier = resolve('scripts/verify-recovery-root-update.ts');
const paths = ['biome.json', 'scripts/report-tcb.ts', 'src/analysis/tcb-semantic-loc.ts'] as const;

function fixture(t: import('node:test').TestContext) {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-root-update-'));
  t.after(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(`${repo}.json`, { force: true });
  });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@local');
  put(
    '.overcenter/source-verification-profile.json',
    JSON.stringify({
      schema: 'overcenter-source-verification-profile/v1',
      id: 'fixture/v1',
      workflow_path: '.github/workflows/verify.yml',
      required_evidence_jobs: ['verify'],
      record_job: 'record',
      commands: ['npm run lint'],
      protected_paths: ['.github', '.overcenter', 'biome.json', 'scripts', 'src/analysis'],
      baseline_test_roots: ['test'],
    }),
  );
  for (const path of paths) put(path, 'base\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  put('test/tcb-semantic-loc.test.ts', 'evidence\n');
  git('add', '.');
  git('commit', '-qm', 'evidence');
  const evidence = git('rev-parse', 'HEAD');
  const evidenceBlob = git('rev-parse', 'HEAD:test/tcb-semantic-loc.test.ts');
  git('checkout', '-q', '--detach', base);
  for (const path of paths) put(path, 'candidate\n');
  git('add', '.');
  git('commit', '-qm', 'candidate');
  const authorization = {
    schema: 'overcenter-recovery-root-update-authorization/v1',
    repository_full_name: 'owner/repo',
    base_sha: base,
    candidate_sha: git('rev-parse', 'HEAD'),
    candidate_tree_sha: git('rev-parse', 'HEAD^{tree}'),
    writable_paths: paths,
    reason: 'measure logical statements',
    authorized_by: 'owner',
    evidence_sha: evidence,
    evidence_path: 'test/tcb-semantic-loc.test.ts',
    evidence_blob_sha: evidenceBlob,
  };
  const run = (changes: Record<string, unknown> = {}, env: Record<string, string> = {}) => {
    const auth = `${repo}.json`;
    writeFileSync(auth, JSON.stringify({ ...authorization, ...changes }));
    return spawnSync(process.execPath, ['--experimental-strip-types', verifier, auth, repo], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REPOSITORY: 'owner/repo',
        GITHUB_REPOSITORY_OWNER: 'owner',
        GITHUB_ACTOR: 'owner',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_SHA: base,
        ...env,
      },
    });
  };
  return { repo, git, put, base, authorization, run };
}

test('accepts exact owner root envelope with immutable evidence', (t) => {
  const f = fixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const receipt = JSON.parse(r.stdout);
  assert.equal(receipt.schema, 'overcenter-recovery-root-update-structural-receipt/v1');
  assert.equal(receipt.candidate_sha, f.authorization.candidate_sha);
  assert.equal(receipt.evidence_blob_sha, f.authorization.evidence_blob_sha);
  assert.equal(receipt.reason, f.authorization.reason);
  assert.match(receipt.authorization_sha256, /^[0-9a-f]{64}$/);
});

for (const [label, changes, env] of [
  ['actor', {}, { GITHUB_ACTOR: 'bot' }],
  ['authorizer', { authorized_by: 'bot' }, {}],
  ['ref', {}, { GITHUB_REF: 'refs/heads/recovery' }],
  ['base', {}, { GITHUB_SHA: 'a'.repeat(40) }],
  ['repository', { repository_full_name: 'other/repo' }, {}],
  ['extra keys', { bypass: true }, {}],
  ['malformed SHA', { candidate_sha: 'main' }, {}],
  ['wrong HEAD', { candidate_sha: 'a'.repeat(40) }, {}],
  ['tree', { candidate_tree_sha: 'a'.repeat(40) }, {}],
  ['reason', { reason: ' ' }, {}],
  ['path traversal', { writable_paths: ['../biome.json'] }, {}],
  ['duplicate', { writable_paths: [...paths, paths[0]] }, {}],
  ['unsorted', { writable_paths: [...paths].reverse() }, {}],
  ['missing path', { writable_paths: [paths[0]] }, {}],
  ['evidence revision', { evidence_sha: 'a'.repeat(40) }, {}],
  ['evidence blob', { evidence_blob_sha: 'a'.repeat(40) }, {}],
  ['evidence path', { evidence_path: 'test/other.test.ts' }, {}],
] as const) {
  test(`rejects ${label}`, (t) => {
    const r = fixture(t).run(changes, env);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
  });
}

for (const path of [
  'package.json',
  '.overcenter/source-verification-profile.json',
  '.github/workflows/protected-source-recovery.yml',
  'scripts/verify-recovery-root-update.ts',
  'scripts/check-recovery-root-update.ts',
  'scripts/run-unit-tests.ts',
]) {
  test(`rejects candidate authority mutation ${path}`, (t) => {
    const f = fixture(t);
    f.put(path, 'malicious\n');
    f.git('add', '.');
    f.git('commit', '--amend', '-qm', 'hostile');
    const r = f.run({
      candidate_sha: f.git('rev-parse', 'HEAD'),
      candidate_tree_sha: f.git('rev-parse', 'HEAD^{tree}'),
      writable_paths: [...paths, path].sort(),
    });
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
  });
}

test('rejects multiple and wrong parents, rename and deletion', (t) => {
  const f = fixture(t);
  const merge = f.git(
    'commit-tree',
    f.authorization.candidate_tree_sha,
    '-p',
    f.base,
    '-p',
    f.authorization.evidence_sha,
    '-m',
    'merge',
  );
  f.git('checkout', '-q', '--detach', merge);
  assert.notEqual(f.run({ candidate_sha: merge }).status, 0);
  f.git('checkout', '-q', '--detach', f.authorization.evidence_sha);
  f.put(paths[0], 'changed');
  f.git('add', '.');
  f.git('commit', '-qm', 'wrong parent');
  assert.notEqual(
    f.run({
      candidate_sha: f.git('rev-parse', 'HEAD'),
      candidate_tree_sha: f.git('rev-parse', 'HEAD^{tree}'),
    }).status,
    0,
  );
  f.git('checkout', '-q', '--detach', f.authorization.candidate_sha);
  f.git('mv', paths[0], 'renamed.json');
  f.git('commit', '--amend', '-qm', 'rename');
  assert.notEqual(
    f.run({
      candidate_sha: f.git('rev-parse', 'HEAD'),
      candidate_tree_sha: f.git('rev-parse', 'HEAD^{tree}'),
    }).status,
    0,
  );
});

test('ordinary recovery cannot update the newly installed root authority', async (t) => {
  const { guardOrdinaryRootAuthority } = await import('../scripts/verify-recovery-root-update.ts');
  const f = fixture(t);
  assert.doesNotThrow(() =>
    guardOrdinaryRootAuthority(f.repo, f.base, f.authorization.candidate_sha),
  );
  for (const path of [
    'scripts/verify-recovery-root-update.ts',
    'scripts/check-recovery-root-update.ts',
  ]) {
    f.put(path, 'self update');
    f.git('add', '.');
    f.git('commit', '--amend', '-qm', 'root authority');
    assert.throws(
      () => guardOrdinaryRootAuthority(f.repo, f.base, f.git('rev-parse', 'HEAD')),
      /ORDINARY_ROOT_AUTHORITY/,
    );
  }
});
