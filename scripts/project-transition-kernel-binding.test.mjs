import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { prepareProjectTransitionLeasePersistence } from '../lib/project-transition-lease-store.js';

const root = new URL('../', import.meta.url);

function row(acquireIdempotencyKey) {
  return {
    lease_id:'11111111-1111-4111-8111-111111111111',
    run_id:'run-project-transition-kernel',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'ship',
    repository:'laurajoyhutchins/overcenter',
    authority_revision:'a'.repeat(40),
    authority_derivation:'overcenter-project-graph-v1',
    graph_fingerprint:'b'.repeat(64),
    transition_definition_fingerprint:'c'.repeat(64),
    transition_revision_fingerprint:'d'.repeat(64),
    transition_dependency_fingerprint:'e'.repeat(64),
    slot_key:'project_transition:github:laurajoyhutchins/overcenter:ship',
    acquire_idempotency_key:acquireIdempotencyKey,
    acquire_request_hash:'f'.repeat(64),
    status:'active',
    created_at:'2026-09-12T20:00:00.000Z',
    expires_at:'2026-09-12T20:30:00.000Z',
    hard_expires_at:'2026-09-12T23:00:00.000Z',
  };
}

test('project-transition persistence derives one stable execution identity and per-acquisition operation identity', async () => {
  const first = await prepareProjectTransitionLeasePersistence(row('acquire-1'), { capabilityToken:'capability-1' });
  const replay = await prepareProjectTransitionLeasePersistence(row('acquire-1'), { capabilityToken:'capability-1' });
  const replacement = await prepareProjectTransitionLeasePersistence(row('acquire-2'), { capabilityToken:'capability-2' });

  assert.match(first.execution_id, /^execution:[0-9a-f]{64}$/);
  assert.match(first.operation_id, /^[0-9a-f-]{36}$/);
  assert.match(first.intent_sha256, /^[0-9a-f]{64}$/);
  assert.equal(first.execution_id, replay.execution_id);
  assert.equal(first.operation_id, replay.operation_id);
  assert.notEqual(first.operation_id, replacement.operation_id);
  assert.equal(first.execution_id, replacement.execution_id);
});

test('project-transition acquisition and lifecycle writes bind canonical execution and operation records', async () => {
  const source = await readFile(new URL('lib/project-transition-lease-store.js', root), 'utf8');
  assert.match(source, /execution_id,subject_key,subject_kind,project_ref,operation_id/);
  assert.match(source, /INSERT INTO operation_state/);
  assert.match(source, /lifecycle='executing'/);
  assert.match(source, /mutation_certainty='definitely_not_mutated'/);
  assert.match(source, /settlement_receipt/);
});

test('project-transition checkpoints and heartbeats persist exact canonical operation identity', async () => {
  const checkpointStart = c.indexOf('async insertCheckpoint');
  const acquireStart = c.indexOf('async acquireLeaseAtomically');
  const checkpoint = c.slice(checkpointStart, acquireStart);
  assert.match(checkpoint, /execution_id,run_id,lease_epoch,authority_epoch/);
  assert.match(checkpoint, /mutation_certainty/);
  assert.match(checkpoint, /may_have_mutated=false/);

  const heartbeatStart = c.indexOf('async extendLeaseWithHeartbeat');
  const deleteStart = c.indexOf('async deleteSlot');
  const heartbeat = c.slice(heartbeatStart, deleteStart);
  assert.match(heartbeat, /execution_id,run_id,lease_epoch,authority_epoch/);
  assert.match(heartbeat, /mutation_certainty/);
  assert.match(heartbeat, /may_have_mutated=false/);
});
