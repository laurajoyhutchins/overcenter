import test from 'node:test';
import assert from 'node:assert/strict';

import './verify-orchestration-horizon-target.test.mjs';
import { runProjectHorizonTests } from '../lib/project-horizon.test.js';

test('project horizon semantics', async () => {
  const result = await runProjectHorizonTests();
  assert.equal(result.ok, true, JSON.stringify(result.tests.filter((entry) => !entry.ok), null, 2));
  assert.equal(result.failed, 0);
});