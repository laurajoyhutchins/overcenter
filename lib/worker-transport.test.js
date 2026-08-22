import { executeSemanticWorkerCommand, validateSemanticWorkerCommand } from 'lib/worker-transport.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function testClaimAcceptsRevisionSemanticShape() {
  const input = validateSemanticWorkerCommand('work.claim', {
    work_ref: 'LJH-365',
    run_id: 'transport-test-run',
    observed_revision: '2026-08-20T08:47:53.997Z',
  });
  check(input.work_ref === 'LJH-365', 'claim should preserve semantic work_ref');
  check(input.observed_revision === '2026-08-20T08:47:53.997Z', 'claim should preserve the exact fresh Linear revision');
  check(!('idempotency_key' in input), 'claim must not add wire fields during validation');
}

async function testClaimRejectsCallerReconstructedStateStrings() {
  let error = null;
  try {
    validateSemanticWorkerCommand('work.claim', {
      work_ref: 'LJH-365',
      run_id: 'transport-test-run',
      observed_state: 'Todo',
      observed_lane: 'lane:repo-implementation',
    });
  } catch (caught) {
    error = caught;
  }
  check(error?.code === 'REQUEST_INVALID', 'semantic claim still accepts caller-reconstructed lifecycle/lane strings');
}

async function testLjh370SourceImplementationUsesServerIssuedRevisionOnly() {
  const input = validateSemanticWorkerCommand('work.claim', {
    work_ref: 'LJH-370',
    run_id: 'source-implementation-contract-test',
    observed_revision: '2026-08-20T13:25:03.000Z',
  });
  check(input.observed_revision === '2026-08-20T13:25:03.000Z', 'LJH-370 fresh authoritative revision was not preserved');
  check(!('observed_state' in input) && !('observed_lane' in input), 'LJH-370 claim still depends on semantic string reconstruction');
}

async function testClaimRejectsWireBookkeeping() {
  let error = null;
  try {
    validateSemanticWorkerCommand('work.claim', {
      work_ref: 'LJH-365',
      run_id: 'transport-test-run',
      observed_revision: '2026-08-20T08:47:53.997Z',
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

async function testDiagnosisIsAvailableThroughSemanticWorkerTransport() {
  const input = validateSemanticWorkerCommand('orchestration.diagnose', {
    run_id: 'transport-test-run',
    work_ref: 'LJH-370',
  });
  check(input.run_id === 'transport-test-run' && input.work_ref === 'LJH-370', 'diagnosis semantic transport lost bounded identifiers');
  let error = null;
  try { validateSemanticWorkerCommand('orchestration.diagnose', { run_id:'transport-test-run', plan:'invent-recovery' }); }
  catch (caught) { error = caught; }
  check(error?.code === 'REQUEST_INVALID', 'diagnosis semantic transport accepted planner-like fields');
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
    observed_revision: '2026-08-20T08:47:53.997Z',
    idempotency_key: 'forbidden-wire-key',
  });
  check(response.status === 400, 'semantic validation rejection should be HTTP 400');
  check(response.body?.ok === false, 'semantic validation rejection should use command-response envelope');
  check(response.body?.error === 'REQUEST_INVALID', 'semantic validation rejection should preserve REQUEST_INVALID');
}

async function testMalformedRevisionFailsBeforeLeaseTransport() {
  const response = await executeSemanticWorkerCommand('work.claim', {
    work_ref: 'LJH-365',
    run_id: 'transport-test-run',
    observed_revision: { updatedAt: '2026-08-20T08:47:53.997Z' },
  });
  check(response.status === 400, 'malformed observed_revision should fail as a request error');
  check(response.body?.error === 'REQUEST_INVALID', 'malformed observed_revision should preserve REQUEST_INVALID');
}

async function testClaimRequiresRevisionOrLegacyPair() {
  const response = await executeSemanticWorkerCommand('work.claim', {
    work_ref: 'LJH-365',
    run_id: 'transport-test-run',
  });
  check(response.status === 400, 'claim without a fresh observation should fail');
  check(response.body?.error === 'REQUEST_INVALID', 'missing observation should preserve REQUEST_INVALID');
}

export async function runWorkerTransportTests() {
  const tests = [
    testClaimAcceptsRevisionSemanticShape,
    testClaimRejectsCallerReconstructedStateStrings,
    testLjh370SourceImplementationUsesServerIssuedRevisionOnly,
    testClaimRejectsWireBookkeeping,
    testLeaseBoundCommandUsesNonSecretLeaseRef,
    testDiagnosisIsAvailableThroughSemanticWorkerTransport,
    testUnsupportedCommandRejected,
    testSemanticValidationReturnsCommandEnvelope,
    testMalformedRevisionFailsBeforeLeaseTransport,
    testClaimRequiresRevisionOrLegacyPair,
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