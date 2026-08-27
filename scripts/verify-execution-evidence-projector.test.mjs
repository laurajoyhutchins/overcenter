import test from 'node:test';
import assert from 'node:assert/strict';
import { runBoundedEvidenceTests } from '../lib/bounded-evidence.test.js';

test('bounded execution evidence projection', async () => {
  const result = await runBoundedEvidenceTests();
  assert.equal(result.ok, true, JSON.stringify(result.results.filter((entry) => !entry.ok), null, 2));
  assert.equal(result.failed, 0);
});
