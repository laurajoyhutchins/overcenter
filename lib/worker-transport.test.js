import { validateSemanticWorkerCommand } from 'lib/worker-transport.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function testClaimAcceptsSemanticShape() {
  const input = validateSemanticWorkerCommand('work.claim', {
    work_ref: 'LJH-365',
    run_id: 'transport-test-run',
    observed_state: 'Todo',
    observed_lane: 'lane:repo-implementation',
  });
  check(input.work_ref === 'LJH-365', 'claim should preserve semantic work_ref');
  check(!('idempotency_key' in input), 'claim must not add wire fields during validation');
}

async function testClaimRejectsWireBookkeeping() {
  let error = null;
  try {
    validateSemanticWorkerCommand('work.claim', {
      work_ref: 'LJH-365',
      run_id: 'transport-test-run',
      observed_state: 'Todo',
      observed_lane: 'lane:repo-implementation',
      idempotency_key: 'caller-owned-wire-key',
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === 'REQUEST_INVALID', 'claim should reject caller-owned wire bookkeeping');
}

async function testLeaseBoundCommandRejectsRunAssociation() {
  let error = null;
  try {
    validateSemanticWorkerCommand('work.settle', {
      lease_token: 'lease-token',
      disposition: 'requeue',
      run_id: 'must-be-derived',
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === 'REQUEST_INVALID', 'settle should reject manually threaded run_id');
}

async function testUnsupportedCommandRejected() {
  let error = null;
  try {
    validateSemanticWorkerCommand('work.delete', {});
  } catch (caught) {
    error = caught;
  }
  check(error?.code === 'REQUEST_INVALID', 'unsupported worker command should be rejected');
}

export async function runWorkerTransportTests() {
  const tests = [
    testClaimAcceptsSemanticShape,
    testClaimRejectsWireBookkeeping,
    testLeaseBoundCommandRejectsRunAssociation,
    testUnsupportedCommandRejected,
  ];
  let passed = 0;
  const failures = [];
  for (const test of tests) {
    try {
      await test();
      passed += 1;
    } catch (error) {
      failures.push({ test: test.name, message: error?.message || String(error) });
    }
  }
  return { ok: failures.length === 0, passed, failed: failures.length, failures };
}