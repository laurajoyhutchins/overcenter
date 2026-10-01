import assert from 'node:assert/strict';
import test from 'node:test';

import { executionPermits } from '../src/authority/transaction-admission.ts';
import type { ExecutionPermit, Run } from '../src/model.ts';

const capabilityA = 'a'.repeat(64);
const capabilityB = 'b'.repeat(64);
const run: Run = {
  id: 'run-1',
  obligation_id: 'effect-1',
  claimed_revision: 'revision-1',
  claim_commit: 'claim-1',
  obligation_key: 'obligation-key-1',
  execution_generation: 1,
  execution_authority_commit: 'authority-1',
  execution_capability_sha256: capabilityA,
};
function permit(overrides: Partial<ExecutionPermit> = {}): ExecutionPermit {
  return { ...run, execution_capability: 'bearer-secret', ...overrides };
}

test('capability Object existence does not imply current permission', () => {
  assert.equal(executionPermits(run, permit(), capabilityA), true);
  assert.equal(executionPermits(run, permit(), capabilityB), false);
});

test('stale authority cannot resurrect after generation advances', () => {
  const current: Run = {
    ...run,
    execution_generation: 2,
    execution_authority_commit: 'authority-2',
    execution_capability_sha256: capabilityB,
  };
  const stale = permit();
  assert.equal(executionPermits(current, stale, capabilityA), false);
  const forgedMetadata: ExecutionPermit = {
    ...stale,
    execution_generation: current.execution_generation,
    execution_authority_commit: current.execution_authority_commit,
    execution_capability_sha256: current.execution_capability_sha256,
  };
  assert.equal(executionPermits(current, forgedMetadata, capabilityA), false);
});

test('copied permit cannot broaden scope or escape its exact revision Coordinate', () => {
  for (const candidate of [
    permit({ obligation_id: 'broader-effect' }),
    permit({ claimed_revision: 'revision-2' }),
    permit({ claim_commit: 'claim-2' }),
    permit({ obligation_key: 'obligation-key-2' }),
  ]) {
    assert.equal(executionPermits(run, candidate, capabilityA), false);
  }
});
