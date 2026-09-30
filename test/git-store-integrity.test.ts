import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitFactStore } from './fixtures/git-fact-store.ts';

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'git-store-integrity-'));
  execFileSync('git', ['init', '--bare', repo], { stdio: 'ignore' });
  const git = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const store = new GitFactStore(repo, { ref: 'refs/overcenter/state' });
  return { repo, git, store, close: () => rmSync(repo, { recursive: true, force: true }) };
}

test('missing payload object cannot silently disappear from authoritative history', () => {
  const f = fixture();
  try {
    const head = f.store.append(null, 'payload', { 'receipt.json': { index: 1 } });
    assert.ok(head);
    const blob = f.git(['rev-parse', `${head}:receipt.json`]);
    rmSync(join(f.repo, 'objects', blob.slice(0, 2), blob.slice(2)));
    assert.throws(() => f.store.history(head));
  } finally {
    f.close();
  }
});

test('merged physical history is rejected rather than reordered into a logical chain', () => {
  const f = fixture();
  try {
    const root = f.store.append(null, 'initialize');
    assert.ok(root);
    const left = f.store.createCommit(root, 'left');
    const right = f.store.createCommit(root, 'right');
    const tree = f.git(['rev-parse', `${root}^{tree}`]);
    const merge = execFileSync(
      'git',
      [
        '-C',
        f.repo,
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@local',
        'commit-tree',
        tree,
        '-p',
        left,
        '-p',
        right,
      ],
      { input: 'merge\n', encoding: 'utf8' },
    ).trim();
    assert.throws(() => f.store.history(merge));
  } finally {
    f.close();
  }
});

test('forged head, truncated objects, and malformed facts fail closed', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.history('f'.repeat(40)));
    const root = f.store.append(null, 'initialize');
    assert.ok(root);
    const next = f.store.append(root, 'claim', { 'claim.json': { test: true } });
    assert.ok(next);
    rmSync(join(f.repo, 'objects', root.slice(0, 2), root.slice(2)));
    assert.throws(() => f.store.history(next));
  } finally {
    f.close();
  }
});

test('validly compressed tampering is detected by physical content identity', async () => {
  const { deflateSync } = await import('node:zlib');
  const { writeFileSync } = await import('node:fs');
  const f = fixture();
  try {
    const head = f.store.append(null, 'payload', { 'receipt.json': { index: 1 } });
    assert.ok(head);
    const blob = f.git(['rev-parse', `${head}:receipt.json`]);
    const payload = Buffer.from('{"index":2}\n');
    rmSync(join(f.repo, 'objects', blob.slice(0, 2), blob.slice(2)));
    writeFileSync(
      join(f.repo, 'objects', blob.slice(0, 2), blob.slice(2)),
      deflateSync(Buffer.concat([Buffer.from(`blob ${payload.length}\0`), payload])),
    );
    assert.throws(() => f.store.history(head), /FACT_OBJECT_DIGEST_MISMATCH/);
  } finally {
    f.close();
  }
});

test('existing empty legacy initialization stays readable without admitting snapshot authority', () => {
  const f = fixture();
  try {
    const root = f.store.createCommit(null, 'legacy initialize', {
      'state.json': { schema: 'overcenter-git-state-v2', obligations: {}, active_run: null },
    });
    assert.equal(f.store.history(root).length, 1);
    const nonempty = f.store.createCommit(null, 'forged snapshot', {
      'state.json': {
        schema: 'overcenter-git-state-v2',
        obligations: { forged: {} },
        active_run: null,
      },
    });
    assert.throws(() => f.store.history(nonempty));
  } finally {
    f.close();
  }
});
