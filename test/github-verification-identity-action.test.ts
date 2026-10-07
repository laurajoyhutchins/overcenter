import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const BINDER = resolve('.github/actions/bind-verification-identity/bind-verification-identity.sh');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(): { cwd: string; base: string; head: string; merge: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'verification-identity-'));
  git(cwd, 'init');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');

  writeFileSync(join(cwd, 'base.txt'), 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'base');
  const base = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'checkout', '-b', 'candidate');
  writeFileSync(join(cwd, 'candidate.txt'), 'candidate\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'candidate');
  const head = git(cwd, 'rev-parse', 'HEAD');

  git(cwd, 'checkout', '-b', 'merge', base);
  git(cwd, 'merge', '--no-ff', '--no-edit', head);
  const merge = git(cwd, 'rev-parse', 'HEAD');

  return { cwd, base, head, merge };
}

function runBinder(cwd: string, env: Record<string, string>) {
  return spawnSync('bash', [BINDER], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

test('binds pull-request verification to exact base, candidate, and tested tree', () => {
  const { cwd, base, head, merge } = fixture();
  const result = runBinder(cwd, {
    OC_EVENT_NAME: 'pull_request',
    OC_EVENT_SHA: merge,
    OC_PR_HEAD_SHA: head,
    OC_PR_BASE_SHA: base,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`candidate_sha=${head}`));
  assert.match(result.stdout, new RegExp(`base_sha=${base}`));
  assert.match(result.stdout, new RegExp(`tested_sha=${merge}`));

  const candidateTree = git(cwd, 'rev-parse', `${head}^{tree}`);
  const testedTree = git(cwd, 'rev-parse', `${merge}^{tree}`);
  assert.equal(candidateTree, testedTree);
  assert.match(result.stdout, new RegExp(`candidate_tree=${candidateTree}`));
  assert.match(result.stdout, new RegExp(`tested_tree=${testedTree}`));
});

test('fails closed when the event head is not the tested merge head parent', () => {
  const { cwd, base, merge } = fixture();
  const result = runBinder(cwd, {
    OC_EVENT_NAME: 'pull_request',
    OC_EVENT_SHA: merge,
    OC_PR_HEAD_SHA: base,
    OC_PR_BASE_SHA: base,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /VERIFICATION_IDENTITY_HEAD_MISMATCH/);
});

test('fails closed when a pull-request verification is not a two-parent merge', () => {
  const { cwd, base, head } = fixture();
  git(cwd, 'checkout', '--detach', head);
  const result = runBinder(cwd, {
    OC_EVENT_NAME: 'pull_request',
    OC_EVENT_SHA: head,
    OC_PR_HEAD_SHA: head,
    OC_PR_BASE_SHA: base,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /VERIFICATION_IDENTITY_MERGE_PARENT_COUNT:1/);
});

test('binds push verification directly to the checked-out revision', () => {
  const { cwd, merge } = fixture();
  const result = runBinder(cwd, {
    OC_EVENT_NAME: 'push',
    OC_EVENT_SHA: merge,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`candidate_sha=${merge}`));
  assert.match(result.stdout, /base_sha=\n/);
});

test('writes literal markdown summary without executing backticks', () => {
  const { cwd, base, head, merge } = fixture();
  const summary = join(cwd, 'summary.md');
  const result = spawnSync('bash', [BINDER], {
    cwd,
    env: {
      ...process.env,
      OC_EVENT_NAME: 'pull_request',
      OC_EVENT_SHA: merge,
      OC_PR_HEAD_SHA: head,
      OC_PR_BASE_SHA: base,
      GITHUB_STEP_SUMMARY: summary,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const body = readFileSync(summary, 'utf8');
  assert.match(body, /- event: `pull_request`/);
  assert.match(body, new RegExp('- candidate SHA: `' + head + '`'));
  assert.match(body, new RegExp('- base SHA: `' + base + '`'));
});
