import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditRepositoryTests } from './test-audit.mjs';

const REVISION = 'a'.repeat(40);

async function fixture(files) {
  const root = await mkdtemp(path.join(tmpdir(), 'overcenter-test-audit-'));
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive:true });
    await writeFile(path.join(root, relative), content);
  }
  return root;
}

test('audit binds deterministic case identities to exact revision', async () => {
  const root = await fixture({
    'scripts/native.test.mjs': "import test from 'node:test';\ntest('native case', () => {});\n",
    'lib/legacy.test.js': 'function testLegacyCase() {}\nexport async function runLegacyTests() { return [await testLegacyCase()]; }\n',
  });
  const first = await auditRepositoryTests({ root, revision:REVISION });
  const second = await auditRepositoryTests({ root, revision:REVISION });
  assert.equal(first.test_file_count, 2);
  assert.equal(first.case_count, 2);
  assert.equal(first.unresolved_shape_count, 0);
  assert.deepEqual(first.cases, second.cases);
  assert.ok(first.cases.every((entry) => /^[0-9a-f]{64}$/.test(entry.audit_id)));
});

test('audit rejects floating revision identity', async () => {
  const root = await fixture({ 'x.test.js': "test('x', () => {});\n" });
  await assert.rejects(() => auditRepositoryTests({ root, revision:'dev' }), /exact 40-character Git revision/);
});

test('audit surfaces dynamic test titles instead of inventing identity', async () => {
  const root = await fixture({ 'x.test.js': 'const title = process.env.NAME; test(title, () => {});\n' });
  const audit = await auditRepositoryTests({ root, revision:REVISION });
  assert.equal(audit.unresolved_shape_count, 1);
  assert.equal(audit.unresolved[0].kind, 'dynamic_test_title');
});
