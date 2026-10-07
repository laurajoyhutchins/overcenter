import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  manifestStaticTree,
  validatePagesManifest,
} from '../src/providers/github/pages-contract.ts';

const limits = { max_files: 10, max_total_bytes: 100, max_observation_calls: 40 };
async function site(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'pages-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.nojekyll'), '');
  await writeFile(join(root, 'index.html'), 'abc');
  return root;
}

test('manifest binds independently known bytes and distinguishes metadata', async (t) => {
  const root = await site(t);
  const manifest = await manifestStaticTree(root, limits);
  assert.equal(manifest.total_bytes, 3);
  assert.equal(manifest.file_count, 2);
  assert.deepEqual(
    manifest.files.map((file) => [file.path, file.delivery]),
    [
      ['.nojekyll', 'metadata'],
      ['index.html', 'served'],
    ],
  );
  assert.equal(
    manifest.files[1]?.sha256,
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.throws(() => validatePagesManifest({ ...manifest, total_bytes: 4 }, limits));
  assert.throws(() =>
    validatePagesManifest({ ...manifest, files: [...manifest.files].reverse() }, limits),
  );
});

test('manifest rejects path and URL collisions', async (t) => {
  for (const name of ['INDEX.html', 'index%2ehtml', '.github', '.git', 'a\\b', 'a?b']) {
    const root = await site(t);
    await writeFile(join(root, name), 'unsafe');
    await assert.rejects(manifestStaticTree(root, limits));
  }
  const root = await site(t);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/file.css'), 'x');
  const manifest = await manifestStaticTree(root, limits);
  for (const path of ['../x', '/x', 'a//b', 'a/../b']) {
    assert.throws(() =>
      validatePagesManifest(
        { ...manifest, files: [{ ...manifest.files[0], path }, ...manifest.files.slice(1)] },
        limits,
      ),
    );
  }
});

test('manifest rejects nonregular files and budgets', async (t) => {
  const root = await site(t);
  await assert.rejects(manifestStaticTree(root, { ...limits, max_files: 1 }));
  await assert.rejects(manifestStaticTree(root, { ...limits, max_total_bytes: 2 }));
  await symlink('index.html', join(root, 'alias.html'));
  await assert.rejects(manifestStaticTree(root, limits));
  await rm(join(root, 'alias.html'));
  await chmod(join(root, 'index.html'), 0o755);
  await assert.rejects(manifestStaticTree(root, limits));
  await chmod(join(root, 'index.html'), 0o644);
  await rm(join(root, '.nojekyll'));
  await assert.rejects(manifestStaticTree(root, limits));
});

test('empty directories and excessive nesting consume a finite traversal budget', async (t) => {
  const root = await site(t);
  for (let i = 0; i < 67; i++) await mkdir(join(root, `d${i}`));
  await assert.rejects(manifestStaticTree(root, { ...limits, max_files: 2 }));
  const nested = await site(t);
  await mkdir(join(nested, ...Array.from({ length: 33 }, () => 'a')), { recursive: true });
  await assert.rejects(manifestStaticTree(nested, limits));
});
