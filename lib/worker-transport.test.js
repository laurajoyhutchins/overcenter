import { executeSemanticWorkerCommand, validateSemanticWorkerCommand } from 'lib/worker-transport.js';

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

async function testLeaseBoundCommandUsesNonSecretLeaseRef() {
  const input = validateSemanticWorkerCommand('work.settle', {
    lease_ref: '00000000-0000-4000-8000-000000000001',
    disposition: 'requeue',
  });
  check(input.lease_ref === '00000000-0000-4000-8000-000000000001', 'settle should accept the non-secret lease reference');
  let error = null;
  try {
    validateSemanticWorkerCommand('work.settle', {
      lease_token: 'must-not-cross-generic-connector',
      disposition: 'requeue',
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === 'REQUEST_INVALID', 'semantic connector should reject raw lease capabilities');
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

async function testSemanticValidationReturnsCommandEnvelope() {
  const response = await executeSemanticWorkerCommand('work.claim', {
    work_ref: 'LJH-365',
    run_id: 'transport-test-run',
    observed_state: 'Todo',
    observed_lane: 'lane:repo-implementation',
    idempotency_key: 'forbidden-wire-key',
  });
  check(response.status === 400, 'semantic validation rejection should be HTTP 400');
  check(response.body?.ok === false, 'semantic validation rejection should use command-response envelope');
  check(response.body?.error === 'REQUEST_INVALID', 'semantic validation rejection should preserve REQUEST_INVALID');
}

export async function runWorkerTransportTests() {
  const tests = [
    testClaimAcceptsSemanticShape,
    testClaimRejectsWireBookkeeping,
    testLeaseBoundCommandUsesNonSecretLeaseRef,
    testUnsupportedCommandRejected,
    testSemanticValidationReturnsCommandEnvelope,
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