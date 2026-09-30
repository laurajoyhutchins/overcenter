import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { GitFactStore } from '../src/storage/git-store.ts';
import { SqliteFactStore } from './fixtures/sqlite-store.ts';

const ref = 'refs/overcenter/state';
const fixture = fileURLToPath(new URL('./fixtures/fact-contender.ts', import.meta.url));
function contender(args: string[]) {
  return new Promise<string | null>((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', fixture, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      error += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(error));
      else resolve((JSON.parse(output) as { commit: string | null }).commit);
    });
  });
}

test('matching authority topologies: shared SQLite and shared Git remote have one CAS winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-topology-'));
  const remote = join(root, 'remote.git');
  const sqlitePath = join(root, 'shared.sqlite');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  const git = new GitFactStore(remote, { ref });
  const sqlite = new SqliteFactStore(sqlitePath);
  try {
    const gh = git.append(null, 'initialize');
    const sh = sqlite.append(null, 'initialize');
    assert.ok(gh);
    assert.ok(sh);
    sqlite.close();
    const clones = [join(root, 'a'), join(root, 'b')];
    for (const clone of clones) execFileSync('git', ['clone', remote, clone], { stdio: 'ignore' });
    const gitResults = await Promise.all(
      clones.map((clone, index) => contender(['git', clone, gh, String(index), 'origin'])),
    );
    const sqliteResults = await Promise.all(
      [0, 1].map((index) => contender(['sqlite', sqlitePath, sh, String(index)])),
    );
    assert.equal(gitResults.filter(Boolean).length, 1);
    assert.equal(sqliteResults.filter(Boolean).length, 1);
    const reopened = new SqliteFactStore(sqlitePath);
    try {
      assert.ok(gitResults.includes(git.head()));
      assert.ok(sqliteResults.includes(reopened.head()));
      assert.equal(git.history(git.head()!).length, 2);
      assert.equal(reopened.history(reopened.head()!).length, 2);
    } finally {
      reopened.close();
    }
    for (const clone of clones) {
      const store = new GitFactStore(clone, { ref, remote: 'origin' });
      assert.equal(store.head(), git.head());
      assert.equal(store.append(gh, 'repeat stale'), null);
    }
    copyFileSync(sqlitePath, join(root, 'replica.sqlite'));
    const first = new SqliteFactStore(sqlitePath);
    const second = new SqliteFactStore(join(root, 'replica.sqlite'));
    try {
      const head = first.head();
      assert.equal(second.head(), head);
      assert.ok(first.append(head, 'host-a'));
      assert.ok(second.append(head, 'host-b'));
      assert.notEqual(
        first.head(),
        second.head(),
        'separate databases are two authorities, not distributed CAS',
      );
    } finally {
      first.close();
      second.close();
    }
  } finally {
    try {
      sqlite.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['accepted', 'unavailable', 'before'] as const) {
  test(`remote push failure ${mode} never masquerades as a stale writer`, () => {
    const root = mkdtempSync(join(tmpdir(), 'git-ambiguity-'));
    const remote = join(root, 'remote.git');
    const clone = join(root, 'clone');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
    execFileSync('git', ['clone', remote, clone], { stdio: 'ignore' });
    const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const wrapper = join(bin, 'git');
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$3" = push ]; then\n  if [ "$FAIL_MODE" = before ]; then exit 1; fi\n  "${actualGit}" "$@" || exit $?\n  touch "${root}/accepted"\n  exit 1\nfi\nif [ "$3" = ls-remote ] && [ "$FAIL_MODE" = unavailable ] && [ -f "${root}/accepted" ]; then exit 1; fi\nexec "${actualGit}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    const originalPath = process.env.PATH;
    const originalMode = process.env.FAIL_MODE;
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.FAIL_MODE = mode;
    try {
      const store = new GitFactStore(clone, { ref, remote: 'origin' });
      if (mode === 'accepted') {
        const commit = store.append(null, 'accepted');
        assert.ok(commit);
        assert.equal(store.head(), commit);
      } else assert.throws(() => store.append(null, 'uncertain'), /AUTHORITY_COMMIT_UNCERTAIN/);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalMode === undefined) delete process.env.FAIL_MODE;
      else process.env.FAIL_MODE = originalMode;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const backend of ['git', 'sqlite'] as const) {
  for (const phase of ['before', 'after'] as const) {
    test(`${backend} process death ${phase} authority advance reconstructs exactly the durable prefix`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'fact-crash-'));
      const path = join(root, backend === 'git' ? 'facts.git' : 'facts.sqlite');
      if (backend === 'git') execFileSync('git', ['init', '--bare', path], { stdio: 'ignore' });
      const open = () =>
        backend === 'git' ? new GitFactStore(path, { ref }) : new SqliteFactStore(path);
      const original = open();
      const expected = original.append(null, 'initialize');
      assert.ok(expected);
      if (original instanceof SqliteFactStore) original.close();
      try {
        await new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [
              '--experimental-strip-types',
              fileURLToPath(new URL('./fixtures/interrupted-fact-writer.ts', import.meta.url)),
              backend,
              path,
              expected,
              phase,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stderr = '';
          let ready = false;
          child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
          });
          child.stdout.once('data', () => {
            ready = true;
            child.kill('SIGKILL');
          });
          child.once('error', reject);
          child.once('close', (_code, signal) => {
            if (ready && signal === 'SIGKILL') resolve();
            else reject(new Error(stderr));
          });
        });
        const reopened = open();
        try {
          const head = reopened.head();
          assert.ok(head);
          assert.equal(reopened.history(head).length, phase === 'after' ? 2 : 1);
          if (phase === 'before') assert.equal(head, expected);
          else assert.equal(reopened.append(expected, 'stale recovery'), null);
        } finally {
          if (reopened instanceof SqliteFactStore) reopened.close();
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test('identical remote append attempts still have exactly one same-head winner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'identical-cas-'));
  const remote = join(root, 'remote.git');
  const clone = join(root, 'clone');
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, clone], { stdio: 'ignore' });
  const authorDate = process.env.GIT_AUTHOR_DATE;
  const committerDate = process.env.GIT_COMMITTER_DATE;
  process.env.GIT_AUTHOR_DATE = '2026-09-30T00:00:00Z';
  process.env.GIT_COMMITTER_DATE = '2026-09-30T00:00:00Z';
  try {
    const store = new GitFactStore(clone, { ref, remote: 'origin' });
    const head = store.append(null, 'initialize');
    assert.ok(head);
    const first = store.append(head, 'same operation');
    assert.ok(first);
    assert.equal(store.append(head, 'same operation'), null);
    const other = join(root, 'other');
    execFileSync('git', ['clone', remote, other], { stdio: 'ignore' });
    const results = await Promise.all(
      [clone, other].map((path) => contender(['git', path, first, 'identical', 'origin'])),
    );
    assert.equal(results.filter(Boolean).length, 1);
  } finally {
    if (authorDate === undefined) delete process.env.GIT_AUTHOR_DATE;
    else process.env.GIT_AUTHOR_DATE = authorDate;
    if (committerDate === undefined) delete process.env.GIT_COMMITTER_DATE;
    else process.env.GIT_COMMITTER_DATE = committerDate;
    rmSync(root, { recursive: true, force: true });
  }
});
