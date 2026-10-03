import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteFactStore as ProductionStore } from '../src/storage/sqlite.ts';
import { SqliteFactStore } from './fixtures/sqlite-store.ts';
import type { FactCommit } from '../src/authority/facts.ts';

function normalize(history: FactCommit[]) {
  const identities = new Map(history.map((fact, index) => [fact.commit, index]));
  return history.map((fact) => ({
    ...fact,
    commit: identities.get(fact.commit),
    parent: fact.parent === null ? null : identities.get(fact.parent),
  }));
}

test('all durable fact fields agree after every prefix, stale append, and reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-equivalence-'));
  const repo = join(root, 'facts.git');
  const path = join(root, 'facts.sqlite');
  execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
  const git = new ProductionStore(repo, { ref: 'refs/overcenter/state' });
  const sqlite = new SqliteFactStore(path);
  try {
    assert.equal(git.head(), sqlite.head());
    const fields = [
      'graph-patch',
      'claim',
      'source-revision',
      'execution-authority',
      'effect-reservation',
      'effect-release',
      'receipt',
    ];
    const old: Array<[string, string]> = [];
    for (let index = 0; index < 32; index += 1) {
      const left = git.head();
      const right = sqlite.head();
      const files =
        index === 0 ? {} : { [`${fields[(index - 1) % fields.length]}.json`]: { index } };
      const a = git.append(left, `operation ${index}`, files);
      const b = sqlite.append(right, `operation ${index}`, files);
      assert.ok(a);
      assert.ok(b);
      old.push([a, b]);
      assert.deepEqual(normalize(git.history(a)), normalize(sqlite.history(b)), `prefix ${index}`);
      for (let retry = 0; retry < 2; retry += 1) {
        assert.equal(git.append(left, 'stale'), null);
        assert.equal(sqlite.append(right, 'stale'), null);
      }
    }
    sqlite.close();
    git.close();
    const reopened = new SqliteFactStore(path);
    const reopenedGit = new ProductionStore(repo, { ref: 'refs/overcenter/state' });
    try {
      for (const [a, b] of old)
        assert.deepEqual(normalize(reopenedGit.history(a)), normalize(reopened.history(b)));
    } finally {
      reopened.close();
      reopenedGit.close();
    }
  } finally {
    git.close();
    try {
      sqlite.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
