import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The claim's source SHA is the immutable profile selector.

const profileModule = await import('../src/source/source-verification-profile.ts').catch(
  () => null,
);

function profile(id = 'fixture/v1') {
  return {
    schema: 'overcenter-source-verification-profile/v2',
    id,
    protected_paths: ['.github', '.overcenter', 'package.json', 'scripts'],
    baseline_test_roots: ['test', 'experiments/semantic-scaling'],
  };
}

function fixture(t: import('node:test').TestContext) {
  const repo = mkdtempSync(join(tmpdir(), 'overcenter-source-profile-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Profile fixture');
  git('config', 'user.email', 'profile@local');
  mkdirSync(join(repo, '.overcenter'), { recursive: true });
  writeFileSync(
    join(repo, '.overcenter/source-verification-profile.json'),
    `${JSON.stringify(profile(), null, 2)}\n`,
  );
  git('add', '-A');
  git('commit', '-qm', 'base profile');
  return { repo, git, base: git('rev-parse', 'HEAD') };
}

test('verification profile is loaded from the exact base and binds a canonical identity', (t) => {
  assert.ok(profileModule, 'source verification profile loader must exist');
  const { repo, git, base } = fixture(t);
  const read = profileModule.readSourceVerificationProfile;
  const initial = read(repo, base);
  assert.equal(initial.profile.id, 'fixture/v1');
  assert.match(initial.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(read(repo, base), initial);

  const changed = profile('fixture/v2');
  writeFileSync(
    join(repo, '.overcenter/source-verification-profile.json'),
    `${JSON.stringify(changed, null, 2)}\n`,
  );
  git('add', '-A');
  git('commit', '-qm', 'change profile');
  const candidate = git('rev-parse', 'HEAD');

  assert.equal(read(repo, base).sha256, initial.sha256);
  assert.notEqual(read(repo, candidate).sha256, initial.sha256);
});

test('profile identity ignores array ordering but rejects missing and unknown profiles', (t) => {
  assert.ok(profileModule, 'source verification profile loader must exist');
  const { repo, git, base } = fixture(t);
  const initial = profileModule.readSourceVerificationProfile(repo, base);
  const reordered = profile();
  reordered.protected_paths.reverse();
  reordered.baseline_test_roots.reverse();
  writeFileSync(
    join(repo, '.overcenter/source-verification-profile.json'),
    `${JSON.stringify(reordered, null, 2)}\n`,
  );
  git('add', '-A');
  git('commit', '-qm', 'reorder profile sets');
  assert.equal(
    profileModule.readSourceVerificationProfile(repo, git('rev-parse', 'HEAD')).sha256,
    initial.sha256,
  );

  git('rm', '.overcenter/source-verification-profile.json');
  git('commit', '-qm', 'remove profile');
  assert.throws(
    () => profileModule.readSourceVerificationProfile(repo, git('rev-parse', 'HEAD')),
    /SOURCE_VERIFICATION_PROFILE_MISSING/,
  );

  mkdirSync(join(repo, '.overcenter'), { recursive: true });
  writeFileSync(
    join(repo, '.overcenter/source-verification-profile.json'),
    JSON.stringify({ ...profile(), schema: 'unknown-profile/v9' }),
  );
  git('add', '-A');
  git('commit', '-qm', 'unknown profile');
  assert.throws(
    () => profileModule.readSourceVerificationProfile(repo, git('rev-parse', 'HEAD')),
    /SOURCE_VERIFICATION_PROFILE_SCHEMA_MISMATCH/,
  );
});
