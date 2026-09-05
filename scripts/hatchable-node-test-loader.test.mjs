import assert from 'node:assert/strict';
import test from 'node:test';
import { load, resolve } from './hatchable-node-test-loader.mjs';

test('maps Hatchable lib namespace to the repository lib tree', async () => {
  const result = await resolve('lib/command-response.js', {}, async () => { throw new Error('default resolver should not run'); });
  assert.equal(result.shortCircuit, true);
  assert.equal(result.url, new URL('../lib/command-response.js', import.meta.url).href);
});

test('maps Hatchable SDK to a virtual fail-closed module', async () => {
  const resolved = await resolve('hatchable', {}, async () => { throw new Error('default resolver should not run'); });
  assert.equal(resolved.shortCircuit, true);
  const loaded = await load(resolved.url, {}, async () => { throw new Error('default loader should not run'); });
  assert.equal(loaded.format, 'module');
  assert.match(loaded.source, /export const api/);
  assert.match(loaded.source, /export const db/);
  assert.match(loaded.source, /export const config/);
  assert.match(loaded.source, /HATCHABLE_SDK_UNAVAILABLE_IN_NODE_TEST/);
});

test('delegates ordinary Node module resolution unchanged', async () => {
  const marker = { url:'node:assert/strict' };
  assert.equal(await resolve('node:assert/strict', {}, async () => marker), marker);
});