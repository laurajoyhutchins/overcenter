import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PRIVATE_SOURCE_MANIFEST_SCHEMA,
  gitBlobSha,
  materializePrivateSource,
  verifyPrivateSourceCapsule,
} from '../src/transport/private-source-capsule.ts';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'private-source-'));
  const cache = join(root, 'cache');
  mkdirSync(cache);

  const a = Buffer.from('alpha\n');
  const b = Buffer.from('#!/bin/sh\necho beta\n');
  const as = gitBlobSha(a);
  const bs = gitBlobSha(b);
  writeFileSync(join(cache, as), a);
  writeFileSync(join(cache, bs), b);

  // Git tree for a.txt + bin/run.sh, independently constructed by git.
  const repo = join(root, 'oracle');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, 'a.txt'), a);
  mkdirSync(join(repo, 'bin'));
  writeFileSync(join(repo, 'bin/run.sh'), b);
  chmodSync(join(repo, 'bin/run.sh'), 0o755);
  execFileSync('git', ['add', '-A'], { cwd: repo });
  const tree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim();

  const manifest = {
    schema: PRIVATE_SOURCE_MANIFEST_SCHEMA,
    repository: 'laurajoyhutchins/arcata',
    revision: '1'.repeat(40),
    tree_sha: tree,
    entries: [
      {
        path: 'bin/run.sh',
        mode: '100755' as const,
        blob_sha: bs,
        size: b.length,
        sha256: sha256(b),
      },
      {
        path: 'a.txt',
        mode: '100644' as const,
        blob_sha: as,
        size: a.length,
        sha256: sha256(a),
      },
    ],
  };

  return { root, cache, manifest, a, b };
}

test('verifies blob identities and reconstructs the authoritative Git tree', () => {
  const f = fixture();
  try {
    assert.equal(verifyPrivateSourceCapsule(f.manifest, f.cache).tree_sha, f.manifest.tree_sha);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('matches Git ordering when a file name is a prefix-neighbor of a directory', () => {
  const f = fixture();
  try {
    const c = Buffer.from('file\n');
    const d = Buffer.from('nested\n');
    const cs = gitBlobSha(c);
    const ds = gitBlobSha(d);
    writeFileSync(join(f.cache, cs), c);
    writeFileSync(join(f.cache, ds), d);

    const repo = join(f.root, 'ordering');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    writeFileSync(join(repo, 'foo.c'), c);
    mkdirSync(join(repo, 'foo'));
    writeFileSync(join(repo, 'foo', 'x'), d);
    execFileSync('git', ['add', '-A'], { cwd: repo });
    const tree = execFileSync('git', ['write-tree'], { cwd: repo, encoding: 'utf8' }).trim();

    const manifest = {
      ...f.manifest,
      tree_sha: tree,
      entries: [
        {
          path: 'foo.c',
          mode: '100644' as const,
          blob_sha: cs,
          size: c.length,
          sha256: sha256(c),
        },
        {
          path: 'foo/x',
          mode: '100644' as const,
          blob_sha: ds,
          size: d.length,
          sha256: sha256(d),
        },
      ],
    };

    assert.equal(verifyPrivateSourceCapsule(manifest, f.cache).tree_sha, tree);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('rejects tampered bytes even under the expected cache key', () => {
  const f = fixture();
  try {
    const first = f.manifest.entries[0];
    assert.ok(first);
    writeFileSync(join(f.cache, first.blob_sha), 'tampered');
    assert.throws(
      () => verifyPrivateSourceCapsule(f.manifest, f.cache),
      /PRIVATE_SOURCE_BLOB_MISMATCH/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('rejects a false authoritative tree claim', () => {
  const f = fixture();
  try {
    assert.throws(
      () => verifyPrivateSourceCapsule({ ...f.manifest, tree_sha: 'f'.repeat(40) }, f.cache),
      /PRIVATE_SOURCE_TREE_MISMATCH/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('rejects unsafe paths, unsupported modes, duplicates, and symbolic revisions', () => {
  const f = fixture();
  try {
    const first = f.manifest.entries[0];
    assert.ok(first);
    for (const entry of [
      { ...first, path: '../escape' },
      { ...first, mode: '120000' },
    ]) {
      assert.throws(() => verifyPrivateSourceCapsule({ ...f.manifest, entries: [entry] }, f.cache));
    }

    assert.throws(() =>
      verifyPrivateSourceCapsule(
        {
          ...f.manifest,
          entries: [first, first],
        },
        f.cache,
      ),
    );
    assert.throws(() => verifyPrivateSourceCapsule({ ...f.manifest, revision: 'main' }, f.cache));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('materializes atomically with exact executable modes', () => {
  const f = fixture();
  try {
    const out = join(f.root, 'out');
    materializePrivateSource(f.manifest, f.cache, out);

    assert.deepEqual(readFileSync(join(out, 'a.txt')), f.a);
    assert.deepEqual(readFileSync(join(out, 'bin/run.sh')), f.b);
    assert.equal(statSync(join(out, 'bin/run.sh')).mode & 0o777, 0o755);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
