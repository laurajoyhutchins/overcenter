import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditRepository } from './test-audit.mjs';

const REVISION = '0123456789abcdef0123456789abcdef01234567';

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'overcenter-test-audit-'));
  await mkdir(join(root, 'lib'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

test('test audit binds literal native test cases to the exact revision', async () => {
  const root = await fixture({
    'lib/example.test.js': "import test from 'node:test';\ntest('alpha', () => {});\ntest(`beta`, () => {});\n",
    'lib/example.spec.js': "import test from 'node:test';\ntest('gamma', () => {});\n",
  });
  try {
    const first = await auditRepository({ root, revision: REVISION });
    const second = await auditRepository({ root, revision: REVISION });
    assert.equal(first.unresolved_count, 0);
    assert.equal(first.case_count, 3);
    assert.deepEqual(first.cases.map((entry) => entry.id), second.cases.map((entry) => entry.id));
    assert.ok(first.cases.every((entry) => /^[0-9a-f]{64}$/.test(entry.id)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test audit discovers supported tests outside historical lib and scripts roots', async () => {
  const root = await fixture({
    'integration/outside.test.js': "import test from 'node:test';\ntest('outside roots', () => {});\n",
  });
  try {
    const result = await auditRepository({ root, revision: REVISION });
    assert.equal(result.unresolved_count, 0);
    assert.deepEqual(result.files, ['integration/outside.test.js']);
    assert.equal(result.case_count, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test audit includes native node:test modifiers and ignores unrelated property calls', async () => {
  const root = await fixture({
    'lib/modifiers.test.js': "import test from 'node:test';\ntest.skip('skipped', () => {});\ntest.todo('todo');\ntest.only('only', () => {});\nconst helper = { test() {} };\nhelper.test('not a test');\n",
  });
  try {
    const result = await auditRepository({ root, revision: REVISION });
    assert.equal(result.unresolved_count, 0);
    assert.equal(result.case_count, 3);
    assert.deepEqual(result.cases.map((entry) => entry.name), ['skipped', 'todo', 'only']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test audit fails closed in its census for dynamic test names', async () => {
  const root = await fixture({
    'scripts/dynamic.test.mjs': "import test from 'node:test';\nconst name = 'dynamic';\ntest(name, () => {});\n",
  });
  try {
    const result = await auditRepository({ root, revision: REVISION });
    assert.equal(result.case_count, 0);
    assert.equal(result.unresolved_count, 1);
    assert.equal(result.unresolved[0].kind, 'dynamic-test-name');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test audit exposes legacy-only files instead of silently omitting them', async () => {
  const root = await fixture({
    'lib/legacy.test.js': "async function run(name, fn) { return fn(); }\nexport async function runLegacyTests() { await run('legacy case', async () => {}); }\n",
  });
  try {
    const result = await auditRepository({ root, revision: REVISION });
    assert.equal(result.case_count, 0);
    assert.equal(result.unresolved_count, 1);
    assert.equal(result.unresolved[0].kind, 'legacy-runner-only');
    assert.equal(result.unresolved[0].legacy_literal_cases, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test audit fails closed when native tests coexist with a legacy runner', async () => {
  const root = await fixture({
    'lib/mixed.test.js': "import test from 'node:test';\nasync function run(name, fn) { return fn(); }\ntest('native case', () => {});\nexport async function runMixedTests() { await run('legacy case', async () => {}); }\n",
  });
  try {
    const result = await auditRepository({ root, revision: REVISION });
    assert.equal(result.case_count, 1);
    assert.equal(result.unresolved_count, 1);
    assert.equal(result.unresolved[0].kind, 'legacy-runner-present');
    assert.equal(result.unresolved[0].legacy_literal_cases, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});