import { settlementFromSemantic } from 'lib/operator-commands.js';
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

async function testSettleAcceptsLifecycleFactsAndRejectsSuccessorSelection() {
  const facts = validateSemanticWorkerCommand('work.settle', {
    lease_ref: '00000000-0000-4000-8000-000000000001',
    disposition: 'completed',
    operating_condition: 'NOMINAL',
    lifecycle_facts: { responsibilities: { EXECUTE:{applicable:true,satisfied:true}, COMMIT:{applicable:true,satisfied:false} } },
  });
  check(facts.lifecycle_facts?.responsibilities?.COMMIT?.satisfied === false, 'settle lost lifecycle facts');
  const canonical = settlementFromSemantic(facts);
  check(canonical.lifecycle_facts?.responsibilities?.COMMIT?.satisfied === false, 'settlement canonicalization discarded lifecycle facts');
  for (const forbidden of [{next_state:'Done'},{next_lane:'lane:verification'}]) {
    let error = null;
    try { validateSemanticWorkerCommand('work.settle', { lease_ref:'00000000-0000-4000-8000-000000000001', disposition:'completed', ...forbidden }); }
    catch (caught) { error = caught; }
    check(error?.code === 'REQUEST_INVALID', 'settle accepted caller-selected lifecycle successor');
    error = null;
    try { settlementFromSemantic({ disposition:'completed', ...forbidden }); }
    catch (caught) { error = caught; }
    check(error?.code === 'REQUEST_INVALID', 'settlement canonicalizer accepted caller-selected lifecycle successor');
  }
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

async function testSkillLifecycleCommandsUseBoundedSemanticShapes() {
  const activation = validateSemanticWorkerCommand('skill.activate', {
    run_id: 'transport-test-run',
    skill: 'systematic-debugging',
    reason: 'implementation tests failed',
  });
  check(activation.skill === 'systematic-debugging', 'skill activation lost the canonical skill name');
  const completion = validateSemanticWorkerCommand('skill.complete', {
    activation_id: '00000000-0000-4000-8000-00000000cafe',
    outcome: 'completed',
    evidence: [{ kind: 'test_run', ref: 'regression-1' }],
  });
  check(completion.outcome === 'completed', 'skill completion lost the bounded outcome');
  let error = null;
  try { validateSemanticWorkerCommand('skill.activate', { run_id:'transport-test-run', skill:'systematic-debugging', tool:'arbitrary' }); }
  catch (caught) { error = caught; }
  check(error?.code === 'REQUEST_INVALID', 'skill activation accepted arbitrary execution fields');
}

function createRuntimeSkillTestDb() {
  const activations = new Map();
  const policy = {
    schema: 'worker-skill-policy-v1',
    source: 'server',
    catalog_revision: 'worker-skills-v1',
    worker: 'Repository Implementation',
    required: [{
      name: 'verification-before-completion',
      revision: 'superpowers-verification-before-completion-v1',
      reference: 'skills://plugins/superpowers/verification-before-completion/skill.md',
      required_before: 'work.complete',
    }],
    available: [],
    forbidden: [],
  };
  return {
    async query(sql, values = []) {
      if (sql.includes('orchestration_command_invocations')) throw new Error('journal unavailable in focused transport test');
      if (sql.includes('SELECT run_id,worker,status,skill_policy FROM orchestration_runs')) {
        return { rows: [{ run_id: values[0], worker: 'Repository Implementation', status: 'active', skill_policy: policy }] };
      }
      if (sql.includes('WHERE run_id=$1 AND skill_name=$2')) return { rows: [] };
      if (sql.includes('INSERT INTO orchestration_skill_activations')) {
        const row = {
          activation_id: '00000000-0000-4000-8000-00000000cafe',
          run_id: values[0], skill_name: values[1], skill_revision: values[2], skill_reference: values[3], reason: values[4],
          status: 'active', evidence: [], created_at: '2026-08-29T03:45:00.000Z', completed_at: null, completion_sha256: null,
        };
        activations.set(row.activation_id, row);
        return { rows: [row] };
      }
      if (sql.includes('SELECT * FROM orchestration_skill_activations WHERE activation_id=$1')) {
        const row = activations.get(values[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('UPDATE orchestration_skill_activations')) {
        const prior = activations.get(values[0]);
        const row = { ...prior, status: values[1], evidence: JSON.parse(values[2]), completion_sha256: values[3], completed_at: '2026-08-29T03:45:01.000Z' };
        activations.set(values[0], row);
        return { rows: [row] };
      }
      throw new Error(`unexpected skill runtime test query: ${sql}`);
    },
  };
}

async function testSkillLifecycleExecutorsReceiveRuntimeDatabase() {
  const db = createRuntimeSkillTestDb();
  const logger = { error() {} };
  const activation = await executeSemanticWorkerCommand('skill.activate', {
    run_id: 'transport-runtime-context-test',
    skill: 'verification-before-completion',
    reason: 'verify exact candidate',
  }, { db, logger });
  check(activation.status === 200 && activation.body?.ok === true, 'skill.activate did not receive the runtime database binding');
  const completion = await executeSemanticWorkerCommand('skill.complete', {
    activation_id: activation.body.activation_id,
    outcome: 'completed',
    evidence: [{ kind: 'test_run', ref: 'worker-runtime-context' }],
  }, { db, logger });
  check(completion.status === 200 && completion.body?.ok === true, 'skill.complete did not receive the runtime database binding');
  check(completion.body?.evidence?.[0]?.ref === 'worker-runtime-context', 'skill completion evidence was not persisted');
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

async function testUnsupportedCommandReturnsCommandEnvelope() {
  const response = await executeSemanticWorkerCommand('work.delete', {});
  check(response.status === 400, 'unsupported semantic command should be HTTP 400');
  check(response.body?.ok === false, 'unsupported semantic command should use command-response envelope');
  check(response.body?.command === 'work.delete', 'unsupported semantic command identity should be preserved');
  check(response.body?.schema_version === 'command-response-v1', 'unsupported semantic command should preserve schema version');
  check(response.body?.error === 'REQUEST_INVALID', 'unsupported semantic command should preserve REQUEST_INVALID');
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

function leaseBoundInput(command, leaseRef) {
  if (command === 'work.checkpoint') return { lease_ref: leaseRef, phase: 'diagnostic', next_action: 'continue', completed: [], evidence: [] };
  if (command === 'work.heartbeat') return { lease_ref: leaseRef, extend_seconds: 1800, phase: 'diagnostic', next_action: 'continue', completed: [], evidence: [] };
  return { lease_ref: leaseRef, disposition: 'requeue', evidence: [], requeue_class: 'retry_runtime_failure' };
}

async function testMalformedLeaseRefsRejectBeforeDatabaseLookup() {
  let dbCalls = 0;
  const db = { async query() { dbCalls += 1; throw new Error('database lookup must not run for malformed lease_ref'); } };
  for (const command of ['work.checkpoint', 'work.heartbeat', 'work.settle']) {
    const response = await executeSemanticWorkerCommand(command, leaseBoundInput(command, 'not-a-uuid'), { db, logger: { error() {} } });
    check(response.status === 400, `${command} malformed lease_ref should be HTTP 400`);
    check(response.body?.error === 'REQUEST_INVALID', `${command} malformed lease_ref should be REQUEST_INVALID`);
    check(response.body?.error_class === 'validation', `${command} malformed lease_ref should be validation class`);
  }
  check(dbCalls === 0, `malformed lease_ref reached the database ${dbCalls} time(s)`);
}

async function testUnknownValidLeaseRefIsBoundedLeaseInvalid() {
  let dbCalls = 0;
  const db = { async query() { dbCalls += 1; return { rows: [] }; } };
  const response = await executeSemanticWorkerCommand('work.checkpoint', leaseBoundInput('work.checkpoint', '00000000-0000-4000-8000-00000000c0de'), { db, logger: { error() {} } });
  check(dbCalls === 1, 'valid unknown lease_ref should perform exactly one identity lookup');
  check(response.status === 409, 'valid unknown lease_ref should be HTTP 409');
  check(response.body?.error === 'LEASE_INVALID', 'valid unknown lease_ref should preserve LEASE_INVALID');
  check(response.body?.message === 'lease reference is invalid', 'unknown lease_ref should use bounded generic lease message');
}

async function testDatabaseFailureIsSanitizedAtWorkerBoundary() {
  const raw = new Error('SQLSTATE[57P01] SELECT * FROM work_leases via db.internal.example database portfolio connection postgres://secret');
  raw.code = '57P01';
  raw.stack = 'Error: SQLSTATE[57P01]\n    at db.internal.example:5432/private.js:99:7';
  const diagnostics = [];
  const db = { async query() { throw raw; } };
  const logger = { error(event, details) { diagnostics.push({ event, details }); } };
  const response = await executeSemanticWorkerCommand('work.checkpoint', leaseBoundInput('work.checkpoint', '00000000-0000-4000-8000-00000000c0de'), { db, logger });
  check(response.status === 500, 'database failure should remain an internal HTTP 500');
  check(response.body?.error === 'WORK_CHECKPOINT_ERROR', 'database failure should map to stable worker command error');
  check(response.body?.error_class === 'internal', 'database failure should retain internal classification');
  check(response.body?.message === 'work.checkpoint failed', 'database failure should use the stable worker message');
  const encoded = JSON.stringify(response.body).toLowerCase();
  for (const forbidden of ['sqlstate', 'select *', 'db.internal.example', 'portfolio', 'postgres://', 'secret', 'private.js', 'stack']) {
    check(!encoded.includes(forbidden), `worker response leaked ${forbidden}`);
  }
  check(diagnostics.length === 1, 'sanitized internal failure should remain observable server-side');
  const diagnostic = JSON.parse(diagnostics[0].event);
  check(diagnostic.failure_kind === 'database_infrastructure', 'database failure diagnostics should retain bounded infrastructure classification');
  const diagnosticEncoded = JSON.stringify(diagnostic).toLowerCase();
  for (const forbidden of ['select *', 'db.internal.example', 'postgres://', 'secret', 'private.js']) {
    check(!diagnosticEncoded.includes(forbidden), `server diagnostic projection leaked ${forbidden}`);
  }
}

async function testUpstreamProviderFailureKeepsStableCodeButSanitizesPayload() {
  const raw = new Error('provider gateway SQLSTATE[XX000] host provider.internal stack trace secret');
  raw.code = 'LINEAR_UPSTREAM_GRAPHQL';
  raw.details = { errors: [{ message: 'raw provider diagnostic secret' }] };
  const diagnostics = [];
  const db = { async query() { throw raw; } };
  const logger = { error(event) { diagnostics.push(JSON.parse(event)); } };
  const response = await executeSemanticWorkerCommand('work.checkpoint', leaseBoundInput('work.checkpoint', '00000000-0000-4000-8000-00000000c0de'), { db, logger });
  check(response.status === 502, 'upstream provider failure should preserve upstream HTTP semantics');
  check(response.body?.error === 'LINEAR_UPSTREAM_GRAPHQL', 'upstream provider failure should preserve stable protocol code');
  check(response.body?.error_class === 'upstream', 'upstream provider failure should preserve upstream classification');
  check(response.body?.message === 'work.checkpoint failed', 'upstream provider failure should use stable worker message');
  const encoded = JSON.stringify(response.body).toLowerCase();
  for (const forbidden of ['sqlstate', 'provider.internal', 'stack trace', 'secret', 'raw provider diagnostic']) {
    check(!encoded.includes(forbidden), `worker response leaked upstream detail ${forbidden}`);
  }
  check(diagnostics[0]?.failure_kind === 'upstream_provider', 'provider failure diagnostics should retain bounded upstream classification');
}

export async function runWorkerTransportTests() {
  const tests = [
    testClaimAcceptsRevisionSemanticShape,
    testClaimRejectsCallerReconstructedStateStrings,
    testLjh370SourceImplementationUsesServerIssuedRevisionOnly,
    testClaimRejectsWireBookkeeping,
    testLeaseBoundCommandUsesNonSecretLeaseRef,
    testSettleAcceptsLifecycleFactsAndRejectsSuccessorSelection,
    testDiagnosisIsAvailableThroughSemanticWorkerTransport,
    testSkillLifecycleCommandsUseBoundedSemanticShapes,
    testSkillLifecycleExecutorsReceiveRuntimeDatabase,
    testUnsupportedCommandRejected,
    testUnsupportedCommandReturnsCommandEnvelope,
    testSemanticValidationReturnsCommandEnvelope,
    testMalformedRevisionFailsBeforeLeaseTransport,
    testClaimRequiresRevisionOrLegacyPair,
    testMalformedLeaseRefsRejectBeforeDatabaseLookup,
    testUnknownValidLeaseRefIsBoundedLeaseInvalid,
    testDatabaseFailureIsSanitizedAtWorkerBoundary,
    testUpstreamProviderFailureKeepsStableCodeButSanitizesPayload,
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