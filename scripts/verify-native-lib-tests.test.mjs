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

test('lib tests are ordinary node:test modules with no parallel regression registry or exported suite runners', async () => {
  const libFiles = (await filesUnder('lib')).filter((file) => file.endsWith('.js')).sort();
  const testLike = libFiles.filter((file) => /\.(?:test|spec)\.js$/.test(file));
  const nonNative = [];
  const legacyRunners = [];
  const specFiles = [];

  for (const file of libFiles) {
    const source = await readFile(new URL(file, root), 'utf8');
    if (file.endsWith('.spec.js')) specFiles.push(file);
    if (/\.(?:test|spec)\.js$/.test(file) && !/from\s+['"]node:test['"]/.test(source)) nonNative.push(file);
    if (/export\s+async\s+function\s+run[A-Z][A-Za-z0-9_$]*(?:Tests|Spec)\s*\(/.test(source)) legacyRunners.push(file);
  }

  assert(testLike.length > 0, 'no lib tests were discovered');
  assert.deepEqual(nonNative, [], `non-node:test lib files:\n${nonNative.join('\n')}`);
  assert.deepEqual(legacyRunners, [], `exported legacy suite runners:\n${legacyRunners.join('\n')}`);
  assert.deepEqual(specFiles, [], `noncanonical .spec.js files:\n${specFiles.join('\n')}`);
  assert(!libFiles.includes('lib/regression-suite-registry.js'), 'parallel lib regression suite registry still exists');
});