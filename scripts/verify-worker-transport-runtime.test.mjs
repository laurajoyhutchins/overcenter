import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../lib/worker-transport.js', import.meta.url), 'utf8');

test('semantic execute handlers receive the explicit runtime context', () => {
  const fixedDispatch = '(request) => spec.execute ? spec.execute(request, runtime) : service[spec.method](request)';
  const brokenDispatch = '(request) => spec.execute ? spec.execute(request) : service[spec.method](request)';

  assert.equal(source.includes(fixedDispatch), true, 'semantic spec.execute handlers must receive runtime explicitly');
  assert.equal(source.includes(brokenDispatch), false, 'runtime-dropping semantic dispatch must not return');
});
