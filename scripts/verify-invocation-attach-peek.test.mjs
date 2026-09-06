import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvocationObservationService } from '../lib/invocation-observation.js';

const invocation = Object.freeze({
  invocation_id: '11111111-1111-4111-8111-111111111111',
  run_id: 'run-1',
  sequence: 7,
  command: 'github.apply_changeset',
  target_kind: 'github_repository',
  target_ref: 'owner/repo',
  request_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  request_projection: { changed_path_count: 1 },
  started_at: '2026-09-06T00:00:00.000Z',
  completed_at: null,
  outcome: 'running',
  error_code: null,
  error_class: null,
  retryable: null,
  rejection: null,
  may_have_mutated: null,
  result_sha256: null,
  result_projection: {},
  schema_version: 'orchestration-journal-v1',
});

function service(row = invocation) {
  return createInvocationObservationService({ store: { async read(invocationId) { return invocationId === invocation.invocation_id ? row : null; } } });
}

test('peek returns a bounded authoritative invocation snapshot', async () => {
  const result = await service().peek({ invocation_id: invocation.invocation_id });
  assert.equal(result.schema, 'invocation-observation-v1');
  assert.equal(result.invocation_id, invocation.invocation_id);
  assert.equal(result.run_id, 'run-1');
  assert.equal(result.sequence, 7);
  assert.equal(result.command, 'github.apply_changeset');
  assert.equal(result.outcome, 'running');
  assert.deepEqual(result.request, { changed_path_count: 1 });
  assert.deepEqual(result.result, {});
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'idempotency_key'), false);
});

test('attach reconnects to the same authoritative invocation identity without creating session state', async () => {
  const result = await service().attach({ invocation_id: invocation.invocation_id });
  assert.equal(result.schema, 'invocation-attachment-v1');
  assert.equal(result.invocation_id, invocation.invocation_id);
  assert.deepEqual(result.attachment, { schema: 'invocation-ref-v1', invocation_id: invocation.invocation_id, run_id: 'run-1', sequence: 7 });
  assert.equal(result.observation.invocation_id, invocation.invocation_id);
  assert.equal(result.observation.outcome, 'running');
});

test('peek and attach fail closed for invalid or unknown invocation identities', async () => {
  await assert.rejects(() => service().peek({ invocation_id: 'not-a-uuid' }), (error) => error.code === 'REQUEST_INVALID');
  await assert.rejects(() => service().attach({ invocation_id: '22222222-2222-4222-8222-222222222222' }), (error) => error.code === 'INVOCATION_NOT_FOUND');
});

// Worker-host binding is verified by the exact-revision runtime build and isolated V8 gate.