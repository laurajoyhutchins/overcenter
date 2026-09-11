import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('library tests use native node:test only', async () => {
  const names = (await readdir(new URL('lib/', root))).filter((name) => /\.(?:test|spec)\.js$/.test(name));
  assert.ok(names.length > 0);
  const violations = [];
  for (const name of names) {
    const source = await readFile(new URL(`lib/${name}`, root), 'utf8');
    if (name.endsWith('.spec.js')) violations.push(`${name}: legacy suffix`);
    if (!source.includes("from 'node:test'")) violations.push(`${name}: missing node:test`);
    if (/export\s+async\s+function\s+run\w*Tests\s*\(/.test(source)) violations.push(`${name}: legacy runner`);
  }
  await assert.rejects(readFile(new URL('lib/regression-suite-registry.js', root)), { code:'ENOENT' });
  await assert.rejects(readFile(new URL('scripts/verify-regression-suite-registry.mjs', root)), { code:'ENOENT' });
  assert.deepEqual(violations, []);
});
