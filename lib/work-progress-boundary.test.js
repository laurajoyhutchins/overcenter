import {
  WORK_CHECKPOINT_INPUT_SCHEMA,
  WORK_CHECKPOINT_REQUIRED_FIELDS,
  WORK_CHECKPOINT_SEMANTIC_FIELDS,
  WORK_HEARTBEAT_INPUT_SCHEMA,
  WORK_HEARTBEAT_REQUIRED_FIELDS,
  WORK_HEARTBEAT_SEMANTIC_FIELDS,
} from 'lib/work-progress-contract.js';
import { canonicalCheckpointCommandByRef, canonicalHeartbeatCommandByRef } from 'lib/operator-commands.js';
import { createSubjectAwareLeaseCheckpointService, createSubjectAwareLeaseHeartbeatService } from 'lib/orchestration-finish-runtime.js';
import { executeSemanticWorkerCommand, validateSemanticWorkerCommand } from 'lib/worker-transport.js';

const LEASE_REF = '00000000-0000-4000-8000-000000000162';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(name, fn) {
  try {
    await fn();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: String(error?.message || error) };
  }
}

function boundaryDb({ known = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (!sql.includes('WHERE lease_id = $1')) throw new Error('unexpected database query in progress boundary regression');
      if (!known) return { rows: [] };
      check(params?.[0] === LEASE_REF, 'progress canonicalization looked up a different lease reference');
      return { rows: [{ lease_id: LEASE_REF, run_id: 'progress-boundary-run', work_ref: 'progress-boundary-work', gate: 'lane:repo-implementation', status: 'active', expires_at: '2026-08-27T19:00:00Z' }] };
    },
  };
}

function assertSharedShape(command, schema, requiredFields, semanticFields, sample) {
  const required = new Set(schema?.required || []);
  const properties = schema?.properties || {};
  check(required.has('lease_ref'), `${command} contract does not require lease_ref`);
  check(!required.has('lease_token') && !properties.lease_token, `${command} contract exposes lease capability material`);
  check(JSON.stringify([...required]) === JSON.stringify([...requiredFields]), `${command} contract required fields drifted`);
  check(JSON.stringify(Object.keys(properties)) === JSON.stringify([...semanticFields]), `${command} contract semantic fields drifted`);

  const semantic = validateSemanticWorkerCommand(command, sample);
  check(semantic.lease_ref === LEASE_REF, `${command} semantic worker transport changed lease_ref`);
  let error = null;
  try { validateSemanticWorkerCommand(command, { ...sample, lease_token: 'secret-capability' }); }
  catch (caught) { error = caught; }
  check(error?.code === 'REQUEST_INVALID', `${command} semantic worker transport accepted lease_token`);
}

export async function runWorkProgressBoundaryTests() {
  const results = [];

  results.push(await run('checkpoint and heartbeat shared contracts match the lease_ref semantic worker boundary', async () => {
    assertSharedShape(
      'work.checkpoint',
      WORK_CHECKPOINT_INPUT_SCHEMA,
      WORK_CHECKPOINT_REQUIRED_FIELDS,
      WORK_CHECKPOINT_SEMANTIC_FIELDS,
      { lease_ref: LEASE_REF, phase: 'candidate', next_action: 'Continue exact candidate.', evidence: [{ kind: 'regression', ref: 'progress-boundary' }] },
    );
    assertSharedShape(
      'work.heartbeat',
      WORK_HEARTBEAT_INPUT_SCHEMA,
      WORK_HEARTBEAT_REQUIRED_FIELDS,
      WORK_HEARTBEAT_SEMANTIC_FIELDS,
      { lease_ref: LEASE_REF, extend_seconds: 300, phase: 'candidate', next_action: 'Continue exact candidate.' },
    );
  }));

  results.push(await run('checkpoint and heartbeat by-reference canonicalization preserves stable retry identity without capability material', async () => {
    const db = boundaryDb();
    const checkpointInput = { lease_ref: LEASE_REF, phase: 'candidate', next_action: 'Continue exact candidate.', evidence: [{ kind: 'regression', ref: 'progress-boundary' }] };
    const firstCheckpoint = await canonicalCheckpointCommandByRef(checkpointInput, db);
    const secondCheckpoint = await canonicalCheckpointCommandByRef(checkpointInput, db);
    check(firstCheckpoint.lease_ref === LEASE_REF && !('lease_token' in firstCheckpoint), 'checkpoint canonicalization exposed capability material');
    check(firstCheckpoint.run_id === 'progress-boundary-run', 'checkpoint canonicalization did not derive run correlation');
    check(firstCheckpoint.idempotency_key === secondCheckpoint.idempotency_key, 'checkpoint exact replay changed retry identity');
    check(/^auto:work\.checkpoint:[0-9a-f]{64}$/.test(firstCheckpoint.idempotency_key), 'checkpoint retry identity is not bounded');

    const heartbeatInput = { lease_ref: LEASE_REF, extend_seconds: 300, phase: 'candidate', next_action: 'Continue exact candidate.' };
    const firstHeartbeat = await canonicalHeartbeatCommandByRef(heartbeatInput, db);
    const secondHeartbeat = await canonicalHeartbeatCommandByRef(heartbeatInput, db);
    check(firstHeartbeat.lease_ref === LEASE_REF && !('lease_token' in firstHeartbeat), 'heartbeat canonicalization exposed capability material');
    check(firstHeartbeat.run_id === 'progress-boundary-run', 'heartbeat canonicalization did not derive run correlation');
    check(firstHeartbeat.idempotency_key === secondHeartbeat.idempotency_key, 'heartbeat exact replay changed retry identity');
    check(/^auto:work\.heartbeat:[0-9a-f]{64}$/.test(firstHeartbeat.idempotency_key), 'heartbeat retry identity is not bounded');
  }));

  results.push(await run('subject-aware checkpoint sends graph-native leases to project transition authority', async () => {
    let legacyCalls = 0;
    let transitionInput = null;
    const service = createSubjectAwareLeaseCheckpointService({
      async readLease(leaseRef) {
        check(leaseRef === LEASE_REF, 'subject-aware checkpoint read a different lease');
        return { lease_id: LEASE_REF, run_id: 'progress-boundary-run', gate: 'project_transition', claim_receipt: { subject: 'project_transition' } };
      },
      legacyLeases: {
        async checkpointByRef() {
          legacyCalls += 1;
          throw new Error('graph-native checkpoint consulted legacy work authority');
        },
      },
      projectTransitions: {
        async checkpoint(input) {
          transitionInput = input;
          return { ok: true, subject: 'project_transition' };
        },
      },
    });
    const result = await service.checkpointByRef({ lease_ref: LEASE_REF, checkpoint: { phase: 'candidate', next_action: 'Continue exact candidate.' }, idempotency_key: 'progress-boundary-subject-checkpoint' });
    check(result?.subject === 'project_transition', 'graph-native checkpoint did not return project transition result');
    check(legacyCalls === 0, 'graph-native checkpoint consulted legacy work authority');
    check(transitionInput?.run_id === 'progress-boundary-run', 'graph-native checkpoint did not derive durable run authority');
    check(transitionInput?.lease_ref === LEASE_REF, 'graph-native checkpoint changed checkpoint semantics');
  }));

  results.push(await run('subject-aware heartbeat sends graph-native leases to project transition authority', async () => {
    let legacyCalls = 0;
    let transitionInput = null;
    const service = createSubjectAwareLeaseHeartbeatService({
      async readLease(leaseRef) {
        check(leaseRef === LEASE_REF, 'subject-aware heartbeat read a different lease');
        return { lease_id: LEASE_REF, run_id: 'progress-boundary-run', gate: 'project_transition', claim_receipt: { subject: 'project_transition' } };
      },
      legacyLeases: {
        async heartbeatByRef() {
          legacyCalls += 1;
          throw new Error('graph-native heartbeat consulted legacy work authority');
        },
      },
      projectTransitions: {
        async heartbeat(input) {
          transitionInput = input;
          return { ok: true, subject: 'project_transition' };
        },
      },
    });
    const result = await service.heartbeatByRef({ lease_ref: LEASE_REF, extend_seconds: 300, idempotency_key: 'progress-boundary-subject-heartbeat' });
    check(result?.subject === 'project_transition', 'graph-native heartbeat did not return project transition result');
    check(legacyCalls === 0, 'graph-native heartbeat consulted legacy work authority');
    check(transitionInput?.run_id === 'progress-boundary-run', 'graph-native heartbeat did not derive durable run authority');
    check(transitionInput?.lease_ref === LEASE_REF && transitionInput?.extend_seconds === 300, 'graph-native heartbeat changed heartbeat semantics');
  }));

  results.push(await run('semantic worker checkpoint composes the subject-aware checkpoint runtime', async () => {
    const db = boundaryDb();
    let executed = null;
    const response = await executeSemanticWorkerCommand(
      'work.checkpoint',
      { lease_ref: LEASE_REF, phase: 'candidate', next_action: 'Continue exact candidate.' },
      {
        db,
        workCheckpoint: {
          async checkpointByRef(input) {
            executed = input;
            return { ok: true, subject: 'project_transition', lease_ref: input.lease_ref, checkpoint_sha256: 'checkpoint-sha' };
          },
        },
      },
    );
    check(response?.body?.ok === true, 'semantic worker checkpoint did not return subject-aware success');
    check(executed?.lease_ref === LEASE_REF && executed?.checkpoint?.phase === 'candidate', 'semantic worker checkpoint bypassed subject-aware runtime composition');
  }));

  results.push(await run('semantic worker heartbeat composes the subject-aware heartbeat runtime', async () => {
    const db = boundaryDb();
    let executed = null;
    const response = await executeSemanticWorkerCommand(
      'work.heartbeat',
      { lease_ref: LEASE_REF, extend_seconds: 300 },
      {
        db,
        workHeartbeat: {
          async heartbeatByRef(input) {
            executed = input;
            return { ok: true, subject: 'project_transition', lease_ref: input.lease_ref, expires_at: '2026-08-27T19:05:00Z' };
          },
        },
      },
    );
    check(response?.body?.ok === true, 'semantic worker heartbeat did not return subject-aware success');
    check(executed?.lease_ref === LEASE_REF && executed?.run_id === 'progress-boundary-run', 'semantic worker heartbeat bypassed subject-aware runtime composition');
  }));

  results.push(await run('malformed and unknown lease references fail before progress mutation', async () => {
    const malformedDb = boundaryDb();
    let malformedError = null;
    try { await canonicalCheckpointCommandByRef({ lease_ref: 'not-a-lease-ref', phase: 'candidate', next_action: 'No mutation.' }, malformedDb); }
    catch (caught) { malformedError = caught; }
    check(malformedError?.code === 'REQUEST_INVALID', 'malformed lease_ref did not fail validation');
    check(malformedDb.calls.length === 0, 'malformed lease_ref reached the lease store');

    const unknownDb = boundaryDb({ known: false });
    let unknownError = null;
    try { await canonicalHeartbeatCommandByRef({ lease_ref: LEASE_REF, extend_seconds: 300 }, unknownDb); }
    catch (caught) { unknownError = caught; }
    check(unknownError?.code === 'LEASE_INVALID', 'unknown lease_ref did not fail closed');
    check(unknownDb.calls.length === 1, 'unknown lease_ref performed unexpected store work');
  }));

  return {
    ok: results.every(result => result.ok),
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
    results,
  };
}