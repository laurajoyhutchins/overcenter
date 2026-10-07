import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveVerificationIdentity } from '../.github/actions/bind-verification-identity/bind-verification-identity.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(): { cwd: string; base: string; head: string; merge: string; event: string } {
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

  const event = join(cwd, 'event.json');
  writeFileSync(
    event,
    JSON.stringify({ pull_request: { head: { sha: head }, base: { sha: base } } }),
  );
  return { cwd, base, head, merge, event };
}

test('binds pull-request verification to exact base, candidate, and tested tree', () => {
  const { cwd, base, head, merge, event } = fixture();
  const identity = deriveVerificationIdentity(cwd, {
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_SHA: merge,
    GITHUB_EVENT_PATH: event,
  });
  assert.equal(identity.baseSha, base);
  assert.equal(identity.candidateSha, head);
  assert.equal(identity.testedSha, merge);
  assert.equal(identity.candidateTree, identity.testedTree);
});

test('fails closed when the event head is not the tested merge head parent', () => {
  const { cwd, base, merge, event } = fixture();
  writeFileSync(
    event,
    JSON.stringify({ pull_request: { head: { sha: base }, base: { sha: base } } }),
  );
  assert.throws(
    () =>
      deriveVerificationIdentity(cwd, {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_SHA: merge,
        GITHUB_EVENT_PATH: event,
      }),
    /VERIFICATION_IDENTITY_HEAD_MISMATCH/,
  );
});

test('fails closed when a pull-request verification is not a two-parent merge', () => {
  const { cwd, head, event } = fixture();
  git(cwd, 'checkout', '--detach', head);
  assert.throws(
    () =>
      deriveVerificationIdentity(cwd, {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_SHA: head,
        GITHUB_EVENT_PATH: event,
      }),
    /VERIFICATION_IDENTITY_MERGE_PARENT_COUNT:1/,
  );
});

test('binds push verification directly to the checked-out revision', () => {
  const { cwd, merge } = fixture();
  const identity = deriveVerificationIdentity(cwd, {
    GITHUB_EVENT_NAME: 'push',
    GITHUB_SHA: merge,
  });
  assert.equal(identity.candidateSha, merge);
  assert.equal(identity.candidateTree, identity.testedTree);
  assert.equal(identity.baseSha, '');
});
