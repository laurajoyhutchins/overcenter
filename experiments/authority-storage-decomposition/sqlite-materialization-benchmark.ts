import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SqliteFactStore } from '../../src/storage/sqlite.ts';
import { GitFactStore } from '../../test/fixtures/git-fact-store.ts';

const root = mkdtempSync(join(tmpdir(), 'sqlite-hot-path-'));
const repo = join(root, 'facts.git');
execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
const store = new SqliteFactStore(repo, { ref: 'refs/overcenter/state' });
try {
  let head: string | null = null;
  for (let i = 0; i < 64; i++) head = store.append(head, `fact ${i}`, { 'receipt.json': { i } });
  assert.ok(head);
  const expected = store.history(head);
  const git = new GitFactStore(repo, { ref: 'refs/overcenter/state' });
  assert.deepEqual(git.history(head), expected);
  const measure = (read: () => unknown) => {
    const start = performance.now();
    for (let i = 0; i < 5; i++) read();
    return (performance.now() - start) / 5;
  };
  let reads = 0;
  store.journal.readObject = () => {
    reads++;
    throw new Error('GIT_HOT_PATH');
  };
  const sqliteMs = measure(() => store.history(head));
  const gitMs = measure(() => git.history(head));
  assert.equal(reads, 0);
  process.stdout.write(
    `${JSON.stringify({ facts: 64, repetitions: 5, verified_sqlite_history_ms: sqliteMs, verified_git_history_ms: gitMs, speedup: gitMs / sqliteMs, sqlite_git_object_reads: reads, scope: 'Same exact immutable history; excludes append and remote CAS latency.' }, null, 2)}\n`,
  );
} finally {
  store.close();
  rmSync(root, { recursive: true, force: true });
}
