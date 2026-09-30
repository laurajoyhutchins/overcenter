import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readSourceVerificationProfile } from '../src/source/source-verification-profile.ts';

const repo = process.cwd();
const base = process.env.BASE_SHA ?? '';
if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('SOURCE_PROFILE_BASE_REVISION_REQUIRED');
const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const submitted = readSourceVerificationProfile(repo, candidate);
let trusted = submitted;
try {
  trusted = readSourceVerificationProfile(repo, base);
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'SOURCE_VERIFICATION_PROFILE_MISSING')
    throw error;
}
if (trusted.sha256 !== submitted.sha256) throw new Error('SOURCE_PROFILE_CANDIDATE_MISMATCH');
if (trusted !== submitted) {
  execFileSync('git', [
    '-C',
    repo,
    'diff',
    '--exit-code',
    base,
    candidate,
    '--',
    ...trusted.profile.protected_paths,
  ]);
}

const worktree = mkdtempSync(join(tmpdir(), 'overcenter-base-tests-'));
let testStatus = 0;
try {
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', worktree, candidate], {
    stdio: 'inherit',
  });
  const roots = trusted.profile.baseline_test_roots;
  const archive = execFileSync('git', ['-C', repo, 'archive', '--format=tar', base, ...roots]);
  for (const root of roots) rmSync(join(worktree, root), { recursive: true, force: true });
  const extracted = spawnSync('tar', ['-xf', '-', '-C', worktree], {
    input: archive,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  if (extracted.error) throw extracted.error;
  if (extracted.status !== 0) throw new Error('SOURCE_BASE_TEST_ARCHIVE_FAILED');
  const changedPaths = execFileSync('git', [
    '-C',
    repo,
    'diff',
    '--name-only',
    '-z',
    base,
    candidate,
  ])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  for (const path of changedPaths) {
    if (
      path.endsWith('.test.ts') &&
      !path.startsWith('/') &&
      !path.split('/').includes('..') &&
      roots.some((root) => path.startsWith(`${root}/`))
    ) {
      let candidateHasTest = true;
      try {
        execFileSync('git', ['-C', repo, 'cat-file', '-e', `${candidate}:${path}`], {
          stdio: 'ignore',
        });
      } catch {
        candidateHasTest = false;
      }
      // Changed test versions run in candidate CI; deleted tests remain in the immutable replay.
      if (candidateHasTest) rmSync(join(worktree, path), { force: true });
    }
  }
  symlinkSync(resolve(repo, 'node_modules'), join(worktree, 'node_modules'), 'dir');

  if (trusted.profile.commands.includes('npm run test:unit')) {
    const result = spawnSync('npm', ['run', 'test:unit'], {
      cwd: worktree,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      testStatus = result.status ?? 1;
    }
  }
} finally {
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], {
      stdio: 'ignore',
    });
  } catch {
    rmSync(worktree, { recursive: true, force: true });
  }
}
process.exitCode = testStatus;
