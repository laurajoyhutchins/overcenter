import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditRepository } from './test-audit.mjs';

const REVISION_A = 'a'.repeat(40);
const REVISION_B = 'b'.repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'overcenter-test-audit-'));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'lib'), { recursive: true });
  await writeFile(join(root, 'scripts', 'native.test.mjs'), "import test from 'node:test';\ntest('native literal case', () => {});\n");
  await writeFile(join(root, 'lib', 'legacy.test.js'), 'export async function runLegacyTests() { return []; }\n');
  await writeFile(join(root, 'lib', 'hidden-regression.js'), 'export async function runHiddenRegressionTests() { return []; }\n');
  return root;
}

test('audit discovers native cases and legacy runners without a parallel registry', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await auditRepository({ root, revision: REVISION_A });
  assert.equal(report.revision, REVISION_A);
  assert.equal(report.test_file_count, 2);
  assert.equal(report.literal_case_count, 1);
  assert.equal(report.unresolved_shape_count, 2);
  assert.deepEqual(report.tests.map((entry) => [entry.source, entry.name]), [['scripts/native.test.mjs', 'native literal case']]);
  assert.deepEqual(report.unresolved.map((entry) => [entry.source, entry.shape, entry.name]), [
    ['lib/hidden-regression.js', 'legacy_suite_runner', 'runHiddenRegressionTests'],
    ['lib/legacy.test.js', 'legacy_suite_runner', 'runLegacyTests'],
  ]);
});

test('audit identities are exact-revision bound', async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await auditRepository({ root, revision: REVISION_A });
  const replay = await auditRepository({ root, revision: REVISION_A });
  const moved = await auditRepository({ root, revision: REVISION_B });
  assert.deepEqual(first, replay);
  assert.notEqual(first.tests[0].audit_id, moved.tests[0].audit_id);
  assert.notEqual(first.unresolved[0].audit_id, moved.unresolved[0].audit_id);
});

test('audit rejects non-exact revision identity', async () => {
  await assert.rejects(() => auditRepository({ root: tmpdir(), revision: 'dev' }), /exact 40-character Git SHA/);
});
