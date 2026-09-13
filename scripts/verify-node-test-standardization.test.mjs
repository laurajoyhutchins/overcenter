import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function filesUnder(directory) {
  const entries = await readdir(new URL(`${directory}/`, root), { withFileTypes:true });
  const files = [];
  for (const entry of entries) {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await filesUnder(relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function exists(path) {
  try { await readFile(new URL(path, root), 'utf8'); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

test('node:test is the only executable test dialect', async () => {
  const violations = [];
  const libFiles = (await filesUnder('lib')).filter((path) => path.endsWith('.js'));
  const testFiles = libFiles.filter((path) => /\.(?:test|spec)\.js$/.test(path));
  assert.ok(testFiles.length > 0, 'expected lib test modules');

  for (const path of testFiles) {
    const source = await readFile(new URL(path, root), 'utf8');
    // Both .test.js and .spec.js are canonical native Node test modules.
    if (!/from\s+['\"]node:test['\"]/.test(source)) violations.push(`${path}: missing node:test import`);
    if (/export\s+async\s+function\s+run[A-Za-z0-9_$]*Tests\s*\(/.test(source)) violations.push(`${path}: exports legacy run*Tests runner`);
    if (/(?:async\s+)?function\s+(?:run|t)\s*\(\s*name\s*,\s*fn\s*\)/.test(source)) violations.push(`${path}: defines a bespoke test runner`);
  }

  for (const path of libFiles.filter((path) => !/\.(?:test|spec)\.js$/.test(path))) {
    const source = await readFile(new URL(path, root), 'utf8');
    if (/export\s+async\s+function\s+run[A-Za-z0-9_$]*Tests\s*\(/.test(source)) violations.push(`${path}: embeds executable tests in production code`);
  }

  for (const path of ['lib/regression-suite-registry.js', 'scripts/verify-regression-suite-registry.mjs']) {
    if (await exists(path)) violations.push(`${path}: legacy test registry still exists`);
  }

  const workflowFiles = (await filesUnder('.github/workflows')).filter((path) => /\.ya?ml$/.test(path));
  for (const path of workflowFiles) {
    const source = await readFile(new URL(path, root), 'utf8');
    if (/run[A-Za-z0-9_$]*Tests/.test(source)) violations.push(`${path}: manually invokes a legacy suite runner`);
  }

  const canonicalRunner = await readFile(new URL('scripts/test.mjs', root), 'utf8');
  if (!/import\s+\{\s*auditRepository\s*\}\s+from\s+['\"]\.\/test-audit\.mjs['\"]/.test(canonicalRunner)) {
    violations.push('scripts/test.mjs: canonical execution does not consume the revision-bound test audit');
  }
  if (!/run\(\['--test',\s*\.\.\.audit\.files\]\)/.test(canonicalRunner)) {
    violations.push('scripts/test.mjs: canonical node:test execution is not sourced from the audit census');
  }
  if (/maintainedTests|regression-suite-registry/.test(canonicalRunner)) {
    violations.push('scripts/test.mjs: parallel manual test inventory still exists');
  }

  assert.deepEqual(violations, []);
});