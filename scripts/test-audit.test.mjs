import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditRepository, discoverAuditedTestPaths } from './test-audit.mjs';

const REVISION = '0123456789abcdef0123456789abcdef01234567';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'overcenter-test-audit-'));
  await mkdir(join(root, 'lib'));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'api'));
  await writeFile(join(root, 'lib', 'native.test.mjs'), `test('lib case', () => {});\n`);
  await writeFile(join(root, 'lib', 'regression-tests-example.mjs'), `export default [{ name: 'scenario', test: () => true }];\n`);
  await writeFile(join(root, 'scripts', 'native.test.mjs'), `test.skip('script skip', () => {});\n`);
  await writeFile(join(root, 'api', 'ignored.test.mjs'), `test('ignored', () => {});\n`);
  return root;
}

test('discovers only supported audit path families in deterministic order', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await discoverAuditedTestPaths(root), [
    'lib/native.test.mjs',
    'lib/regression-tests-example.mjs',
    'scripts/native.test.mjs',
  ]);
});

test('emits a revision-bound exhaustive manifest when all shapes resolve', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await auditRepository({ root, revision: REVISION });
  assert.equal(result.ok, true);
  assert.equal(result.revision, REVISION);
  assert.equal(result.discovered_files, 3);
  assert.equal(result.unresolved.length, 0);
  assert.equal(result.identities.length, 3);
  assert.equal(result.totals.files, 3);
  assert.equal(result.totals.tests, 2);
  assert.equal(result.totals.skips, 1);
  assert.equal(result.totals.cases, 3);
  assert.match(result.manifest_sha256, /^[0-9a-f]{64}$/);
  assert.ok(result.identities.every((identity) => identity.revision === REVISION));
});

test('reports every unresolved shape instead of silently omitting it', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'scripts', 'dynamic.test.mjs'), 'registerTests(cases);\n');
  await writeFile(join(root, 'lib', 'broken.test.mjs'), `test('broken', () => {\n`);
  const result = await auditRepository({ root, revision: REVISION });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unresolved.map((entry) => entry.path), [
    'lib/broken.test.mjs',
    'scripts/dynamic.test.mjs',
  ]);
  assert.ok(result.unresolved.every((entry) => entry.code === 'TEST_SHAPE_UNRESOLVED'));
});

test('manifest identity changes when exact source or revision changes', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await auditRepository({ root, revision: REVISION });
  await writeFile(join(root, 'scripts', 'native.test.mjs'), `test.skip('script skip changed', () => {});\n`);
  const changedSource = await auditRepository({ root, revision: REVISION });
  const changedRevision = await auditRepository({ root, revision: '1123456789abcdef0123456789abcdef01234567' });
  assert.notEqual(first.manifest_sha256, changedSource.manifest_sha256);
  assert.notEqual(changedSource.manifest_sha256, changedRevision.manifest_sha256);
});
