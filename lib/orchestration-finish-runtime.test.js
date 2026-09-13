import assert from 'node:assert/strict';
import test from 'node:test';

import { createSubjectAwareLeaseSettlementService } from './orchestration-finish-runtime.js';

const LEASE_REF = '11111111-1111-4111-8111-111111111111';

function projectTransitionLease() {
  return {
    lease_id:LEASE_REF,
    run_id:'run-continuation',
    gate:'project_transition',
    claim_receipt:{ subject:'project_transition' },
  };
}

test('project-transition settlement durably checkpoints continuation before settlement', async () => {
  const calls = [];
  const continuation = { candidate_revision:'abc123', remaining:['verify'] };
  const projectTransitions = {
    async checkpoint(input) {
      calls.push(['checkpoint', input]);
      return { ok:true };
    },
    async settle(input) {
      calls.push(['settle', input]);
      return { ok:true, status:'settled' };
    },
  };
  const service = createSubjectAwareLeaseSettlementService({
    readLease:async () => projectTransitionLease(),
    legacyLeases:{ settleByRef:async () => { throw new Error('legacy settlement must not run'); } },
    projectTransitions,
  });

  await service.settleByRef({
    lease_ref:LEASE_REF,
    disposition:'requeue',
    continuation,
    idempotency_key:'settle-continuation',
  });

  assert.deepEqual(calls, [
    ['checkpoint', {
      lease_ref:LEASE_REF,
      run_id:'run-continuation',
      checkpoint:continuation,
      idempotency_key:'settle-continuation:continuation',
    }],
    ['settle', {
      lease_ref:LEASE_REF,
      run_id:'run-continuation',
      disposition:'requeue',
      evidence:undefined,
      reason:undefined,
      promotion_condition:undefined,
      idempotency_key:'settle-continuation',
    }],
  ]);
});

test('project-transition settlement does not invent a checkpoint without continuation', async () => {
  let checkpoints = 0;
  const projectTransitions = {
    async checkpoint() { checkpoints += 1; },
    async settle() { return { ok:true, status:'settled' }; },
  };
  const service = createSubjectAwareLeaseSettlementService({
    readLease:async () => projectTransitionLease(),
    legacyLeases:{ settleByRef:async () => { throw new Error('legacy settlement must not run'); } },
    projectTransitions,
  });

  await service.settleByRef({
    lease_ref:LEASE_REF,
    disposition:'completed',
    idempotency_key:'settle-without-continuation',
  });

  assert.equal(checkpoints, 0);
});
