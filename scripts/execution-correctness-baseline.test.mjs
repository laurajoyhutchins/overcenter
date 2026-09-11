import test from 'node:test';
import assert from 'node:assert/strict';
import { measureExecutionCorrectness } from './measure-execution-correctness.mjs';

test('measurement reports every execution-correctness dimension', async () => {
  const result = await measureExecutionCorrectness({ root: new URL('../', import.meta.url) });
  for (const field of [
    'production_lines',
    'production_bytes',
    'test_lines',
    'test_bytes',
    'lease_implementations',
    'recovery_implementations',
    'settlement_implementations',
    'mutation_certainty_implementations',
    'provider_generic_protocol_implementations',
    'compatibility_modules',
    'lifecycle_models',
  ]) {
    assert.equal(typeof result[field], 'number', field);
  }
});
