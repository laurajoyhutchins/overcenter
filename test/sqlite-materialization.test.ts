import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteFactStore } from '../src/storage/sqlite.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-materialization-'));
  const repo = join(root, 'repo.git');
  execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
  const cachePath = join(root, 'cache.sqlite');
  const open = () => new SqliteFactStore(repo, { ref: 'refs/overcenter/state', cachePath });
  return { root, repo, cachePath, open };
}

test('warm and reopened history use SQLite with zero Git object reads', () => {
  const f = fixture();
  const store = f.open();
  try {
    let head: string | null = null;
    for (let i = 0; i < 32; i++) head = store.append(head, `fact ${i}`, { 'receipt.json': { i } });
    assert.ok(head);
    const expected = store.history(head);
    store.close();
    const reopened = f.open();
    try {
      reopened.journal.readObject = () => {
        throw new Error('GIT_HOT_PATH');
      };
      assert.deepEqual(reopened.history(head), expected);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('SQLite object tampering cannot forge a fact under a retained Git identity', () => {
  const f = fixture();
  const store = f.open();
  try {
    const head = store.append(null, 'fact', { 'receipt.json': { i: 1 } })!;
    store.history(head);
    store.close();
    const db = new DatabaseSync(f.cachePath);
    db.prepare("UPDATE objects SET bytes = ? WHERE type = 'blob'").run(Buffer.from('{"i":2}\n'));
    db.close();
    const reopened = f.open();
    try {
      assert.throws(() => reopened.history(head), /FACT_OBJECT_DIGEST_MISMATCH/);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('deleting materialization preserves history and never creates a local authority head', () => {
  const f = fixture();
  const store = f.open();
  try {
    const head = store.append(null, 'fact', { 'receipt.json': { i: 1 } })!;
    const expected = store.history(head);
    store.close();
    rmSync(f.cachePath);
    const reopened = f.open();
    try {
      assert.equal(reopened.head(), head);
      assert.deepEqual(reopened.history(head), expected);
      const db = new DatabaseSync(f.cachePath);
      assert.deepEqual(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name),
        ['objects'],
      );
      db.close();
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
