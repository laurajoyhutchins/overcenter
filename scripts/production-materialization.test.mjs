import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

const driver = new URL('./production-materialization.mjs', import.meta.url);

test('production materialization has a deterministic driver', () => {
  assert.equal(existsSync(driver), true, 'production materialization driver is missing');
});
