import test from 'node:test';
import assert from 'node:assert/strict';

import './verify-project-transition-lease-recovery.test.mjs';
import './verify-project-transition-revision-continuation.test.mjs';
import './verify-project-transition-continuation-wiring.test.mjs';
import './verify-project-transition-settlement-replay-evidence.test.mjs';
import './verify-project-transition-heartbeat-replay-evidence.test.mjs';
import './verify-project-transition-checkpoint-revision-evidence.test.mjs';
import './verify-project-transition-resume-revision-evidence.test.mjs';
import { runProjectTransitionLeaseTests } from '../lib/project-transition-leases.test.js';

test('project transition lease semantics', async () => {
  const result = await runProjectTransitionLeaseTests();
  assert.equal(result.ok, true, JSON.stringify(result.tests.filter((entry) => !entry.ok), null, 2));
  assert.equal(result.failed, 0);
});