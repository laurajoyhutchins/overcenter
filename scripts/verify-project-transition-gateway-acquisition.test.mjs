import assert from 'node:assert/strict';
import test from 'node:test';
import { createProjectTransitionLeasePostgresStore } from '../lib/project-transition-lease-store.js';

const row = Object.freeze({
  lease_id:'11111111-1111-4111-8111-111111111111',
  slot_key:'project_transition:github:example/repo:atlas',
  run_id:'run-atlas',
  project_ref:'github:example/repo',
  transition_id:'atlas',
  repository:'example/repo',
  authority_revision:'a'.repeat(40),
  authority_derivation:'overcenter-project-graph-v1',
  graph_fingerprint:'b'.repeat(64),
  transition_definition_fingerprint:'c'.repeat(64),
  transition_revision_fingerprint:'d'.repeat(64),
  transition_dependency_fingerprint:'e'.repeat(64),
  acquire_idempotency_key:'atlas-acquire',
  acquire_request_hash:'f'.repeat(64),
  status:'active',
  created_at:'2026-09-02T15:30:00.000Z',
  expires_at:'2026-09-02T16:00:00.000Z',
  hard_expires_at:'2026-09-02T18:30:00.000Z',
});

function assertDenseParameterVector(item) {
  const indexes = [...item.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  const unique = [...new Set(indexes)].sort((a, b) => a - b);
  assert.deepEqual(unique, Array.from({ length:item.params.length }, (_, index) => index + 1));
}

function leaseRow(authorityEpoch = 1) {
  return {
    lease_id:row.lease_id,
    work_ref:row.slot_key,
    gate:'project_transition',
    run_id:row.run_id,
    claim_idempotency_key:`project-transition:${row.acquire_idempotency_key}`,
    claim_request_hash:row.acquire_request_hash,
    claim_receipt:{
      subject:'project_transition',
      project_transition:{
        project_ref:row.project_ref,
        transition_id:row.transition_id,
        repository:row.repository,
        authority_revision:row.authority_revision,
        authority_derivation:row.authority_derivation,
        graph_fingerprint:row.graph_fingerprint,
        transition_definition_fingerprint:row.transition_definition_fingerprint,
        transition_revision_fingerprint:row.transition_revision_fingerprint,
        transition_dependency_fingerprint:row.transition_dependency_fingerprint,
        slot_key:row.slot_key,
        authority_epoch:authorityEpoch,
      },
    },
    status:'active',
    created_at:row.created_at,
    expires_at:row.expires_at,
    hard_expires_at:row.hard_expires_at,
  };
}

test('project transition acquisition uses the transaction primitive instead of a data-modifying query CTE', async () => {
  let queryCalls = 0;
  let transactionItems = null;
  const db = {
    async query() {
      queryCalls += 1;
      throw new Error('db.query must not execute project-transition acquisition mutations');
    },
    async transaction(items) {
      transactionItems = items;
      return {
        results:[
          { rows:[{ authority_epoch:1 }] },
          { rows:[leaseRow()] },
          { rows:[{ lease_id:row.lease_id }] },
          { rows:[{ atomicity_guard:1 }] },
        ],
      };
    },
  };

  const store = createProjectTransitionLeasePostgresStore(db, { capabilityFactory:()=> 'ptl_test_capability' });
  const lease = await store.acquireLeaseAtomically(row);

  assert.equal(queryCalls, 0);
  assert.equal(transactionItems?.length, 4);
  assert.match(transactionItems[0].sql, /INSERT INTO execution_state/);
  assert.doesNotMatch(transactionItems[0].sql, /WITH advanced/);
  assert.equal(transactionItems[0].params.length, 37);
  assertDenseParameterVector(transactionItems[0]);
  assert.match(transactionItems[1].sql, /INSERT INTO work_leases/);
  assert.equal(transactionItems[1].params.length, 8);
  assertDenseParameterVector(transactionItems[1]);
  assert.match(transactionItems[2].sql, /INSERT INTO work_lease_slots/);
  assert.equal(lease.lease_id, row.lease_id);
  assert.equal(lease.authority_epoch, 1);
});

test('project transition acquisition maps the transaction atomicity guard to ordinary contention', async () => {
  let queryCalls = 0;
  const db = {
    async query() {
      queryCalls += 1;
      return { rows:[] };
    },
    async transaction() {
      throw Object.assign(new Error('division by zero'), { code:'22012' });
    },
  };
  const store = createProjectTransitionLeasePostgresStore(db, { capabilityFactory:()=> 'ptl_test_capability' });
  await assert.rejects(
    () => store.acquireLeaseAtomically(row),
    (error) => error?.code === 'UNIQUE_VIOLATION' && /occupied/.test(error.message),
  );
  assert.equal(queryCalls, 1);
});


test('project transition acquisition replays the canonical winner after same-key contention', async () => {
  let queryCalls = 0;
  const canonical = {
    ...row,
    subject_kind:'project_transition',
    execution_id:'execution:project-transition',
    operation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    lifecycle:'executing',
    settled:false,
    authority_epoch:1,
    lease_ref:row.lease_id,
    idempotency_scope:'project_transition',
    idempotency_key:row.acquire_idempotency_key,
    intent_sha256:'1'.repeat(64),
    acquire_request_hash:row.acquire_request_hash,
  };
  const db = {
    async query(sql, params) {
      queryCalls += 1;
      assert.match(sql, /idempotency_scope/);
      assert.deepEqual(params, ['project_transition', row.acquire_idempotency_key]);
      return { rows:[canonical] };
    },
    async transaction() {
      throw Object.assign(new Error('atomicity guard contention'), { code:'22012' });
    },
  };
  const store = createProjectTransitionLeasePostgresStore(db, { capabilityFactory:()=> 'ptl_test_capability' });
  const replay = await store.acquireLeaseAtomically(row);
  assert.equal(replay.lease_id, row.lease_id);
  assert.equal(replay.execution_id, canonical.execution_id);
  assert.equal(replay.operation_id, canonical.operation_id);
  assert.equal(queryCalls, 1);
});
