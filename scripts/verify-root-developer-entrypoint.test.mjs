import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function json(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
}

test('repository exposes a mundane npm developer front door', async () => {
  const packageJson = await json('package.json');
  const packageLock = await json('package-lock.json');

  assert.equal(packageJson.name, 'overcenter');
  assert.equal(packageJson.private, true);
  assert.match(packageJson.engines?.node ?? '', /22/);

  for (const script of ['test', 'build', 'dev', 'verify']) {
    assert.equal(typeof packageJson.scripts?.[script], 'string', `missing npm script: ${script}`);
    assert.ok(packageJson.scripts[script].trim(), `empty npm script: ${script}`);
  }

  assert.equal(packageJson.devDependencies?.typescript, '5.9.2');
  assert.equal(packageJson.dependencies?.pg, '8.13.1');
  assert.equal(packageLock.name, packageJson.name);
  assert.equal(packageLock.lockfileVersion, 3);
});