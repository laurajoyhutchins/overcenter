import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { prepareProjectTransitionLeasePersistence, restoreProjectTransitionLease } from '../lib/project-transition-lease-store.js';
import { createPostgresExecutionAuthorityStore } from '../lib/execution-authority.js';

const root = new URL('../', import.meta.url);

async function projectTransitionStoreSource() {
  return readFile(new URL('lib/project-transition-lease-store.js', root), 'utf8');
}

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
  const source = await projectTransitionStoreSource();
  const c = source;
  assert.match(source, /execution_id,subject_key,subject_kind,project_ref,transition_id,operation_id/);
  assert.match(source, /INSERT INTO operation_state/);
  assert.match(source, /lifecycle='executing'/);
  assert.match(source, /mutation_certainty='definitely_not_mutated'/);
  assert.match(source, /settlement_receipt/);

  const acquireStart = source.indexOf('async acquireLeaseAtomically');
  const acquire = source.slice(acquireStart);
  assert.match(acquire, /SELECT \$21,'execution\.transaction',\$23,\$24,\$22,'prepared'/);
  assert.match(acquire, /'definitely_not_mutated',\$25/);
});

test('project-transition checkpoints and heartbeats persist exact canonical operation identity', async () => {
  const c = await projectTransitionStoreSource();
  const checkpointStart = c.indexOf('async insertCheckpoint');
  const acquireStart = c.indexOf('async acquireLeaseAtomically');
  const checkpoint = c.slice(checkpointStart, acquireStart);
  assert.match(checkpoint, /execution_id,subject_key,run_id,lease_epoch,authority_epoch/);
  assert.match(checkpoint, /mutation_certainty/);
  assert.match(checkpoint, /may_have_mutated=false/);

  const heartbeatStart = c.indexOf('async extendLeaseWithHeartbeat');
  const deleteStart = c.indexOf('async deleteSlot');
  const heartbeat = c.slice(heartbeatStart, deleteStart);
  assert.match(heartbeat, /execution_id,subject_key,run_id,lease_epoch,authority_epoch/);
  assert.match(heartbeat, /mutation_certainty/);
  assert.match(heartbeat, /may_have_mutated=false/);
});

test('project-transition settlement writes the canonical durable receipt and lifecycle', async () => {
  const c = await projectTransitionStoreSource();
  const settlementStart = c.indexOf('async settleLeaseAtomically');
  const heartbeatStart = c.indexOf('async extendLeaseWithHeartbeat');
  const settlement = c.slice(settlementStart, heartbeatStart);
  assert.match(settlement, /UPDATE operation_state/);
  assert.match(settlement, /lifecycle='settled'/);
  assert.match(settlement, /settled=true/);
  assert.match(settlement, /settlement_receipt/);
  assert.match(settlement, /authority_epoch/);
});

test('settled canonical transition executions are not reclassified as expired leases', async () => {
  const source = await readFile(new URL('lib/project-transition-leases.js', root), 'utf8');
  assert.match(source, /execution\?\.lifecycle !== 'settled'/);
  assert.match(source, /execution\?\.settled !== true/);
});

test('authoritative project-transition GitHub effect is kernel-bound and confirm-only after uncertainty', async () => {
  const runtime = await readFile(new URL('lib/project-transition-authoritative-effect-github-runtime.js', root), 'utf8');
  const wrapper = await readFile(new URL('lib/execution-provider-wrapper.js', root), 'utf8');
  const mcp = await readFile(new URL('mcp/project.advance.js', root), 'utf8');
  assert.match(runtime, /executeBoundProviderEffect/);
  assert.match(runtime, /executionTransactionStore/);
  assert.match(runtime, /allowIntegration: true/);
  assert.match(runtime, /allowIntegration: false/);
  assert.match(wrapper, /input\.subject_kind/);
  assert.match(mcp, /executionTransactionStore/);

  const confirmationStart = runtime.indexOf('function confirmationFacts');
  const confirmationEnd = runtime.indexOf('function kernelAuthority', confirmationStart);
  const facts = runtime.slice(confirmationStart, confirmationEnd);
  assert.match(facts, /reason === 'authoritative_effect_not_observed'/);
  assert.match(facts, /status:'unknown'/);
  assert.doesNotMatch(facts, /reason === 'authoritative_effect_not_observed'[\s\S]*status:'absent'/);
});

test('restored project-transition settlement exposes the canonical receipt to orchestration', () => {
  const receipt = {
    schema:'settlement-receipt-v1',
    execution_id:'execution:transition-receipt',
    operation_id:'11111111-1111-4111-8111-111111111111',
    authority_revision:'a'.repeat(40),
    authority_epoch:2,
    lifecycle:'settled',
    disposition:'completed',
    effect_ref:null,
    evidence_sha256:'b'.repeat(64),
  };
  const restored = restoreProjectTransitionLease({
    lease_id:'22222222-2222-4222-8222-222222222222',
    run_id:'run-transition-receipt',
    work_ref:'project_transition:receipt',
    status:'settled',
    claim_idempotency_key:'project-transition:acquire',
    claim_request_hash:'c'.repeat(64),
    claim_receipt:{
      subject:'project_transition',
      project_transition:{
        project_ref:'github:laurajoyhutchins/overcenter',
        transition_id:'receipt',
        repository:'laurajoyhutchins/overcenter',
        authority_revision:'a'.repeat(40),
        authority_derivation:'overcenter-project-graph-v1',
        graph_fingerprint:'d'.repeat(64),
        transition_definition_fingerprint:'e'.repeat(64),
        transition_revision_fingerprint:'f'.repeat(64),
        transition_dependency_fingerprint:'0'.repeat(64),
        slot_key:'project_transition:receipt',
      },
    },
    settle_receipt:{ canonical_receipt:receipt },
  });
  assert.deepEqual(restored?.settlement_receipt, receipt);
});


test('Postgres execution authority projects current project-transition identity from canonical execution state', async () => {
  const leaseRef = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return {
        rows:[{
          lease_id:leaseRef,
          subject_key:'project_transition:canonical',
          subject_kind:'project_transition',
          run_id:'run-canonical',
          project_ref:'github:laurajoyhutchins/overcenter',
          transition_id:'ship',
          authority_epoch:3,
          authority_repository:'laurajoyhutchins/overcenter',
          authority_revision:'a'.repeat(40),
          authority_derivation:'overcenter-project-graph-v1',
          graph_fingerprint:'b'.repeat(64),
          transition_definition_fingerprint:'c'.repeat(64),
          transition_revision_fingerprint:'d'.repeat(64),
          transition_dependency_fingerprint:'e'.repeat(64),
          lifecycle:'executing',
          settled:false,
          expires_at:'2026-09-12T20:30:00.000Z',
          hard_expires_at:'2026-09-12T23:00:00.000Z',
          idempotency_key:'acquire-canonical',
          intent_sha256:'f'.repeat(64),
        }],
      };
    },
  };
  const store = createPostgresExecutionAuthorityStore(db);
  const lease = await store.getLeaseById(leaseRef);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /FROM execution_state/);
  assert.match(calls[0].sql, /subject_kind='project_transition'/);
  assert.doesNotMatch(calls[0].sql, /FROM work_leases/);
  assert.equal(lease.lease_id, leaseRef);
  assert.equal(lease.status, 'active');
  assert.equal(lease.claim_receipt.subject, 'project_transition');
  assert.equal(lease.claim_receipt.project_transition.authority_epoch, 3);
  assert.equal(lease.claim_receipt.project_transition.slot_key, 'project_transition:canonical');
  assert.equal(Object.hasOwn(lease, 'active_capability_material'), false);
});


test('project-transition slot reads use canonical execution identity', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows:[{ slot_key:'project_transition:canonical-slot', lease_id:'99999999-9999-4999-8999-999999999999', expires_at:'2026-09-12T20:30:00.000Z' }] };
    },
  };
  const store = (await import('../lib/project-transition-lease-store.js')).createProjectTransitionLeasePostgresStore(db);
  const slot = await store.getSlot('project_transition:canonical-slot');
  assert.equal(slot?.lease_id, '99999999-9999-4999-8999-999999999999');
  assert.match(calls[0].sql, /FROM execution_state/);
  assert.doesNotMatch(calls[0].sql, /FROM work_lease_slots/);
});

test('project-transition historical receipt replay uses projection history only after canonical lookup misses', async () => {
  const leaseRef = '88888888-8888-4888-8888-888888888888';
  const subjectKey = 'project_transition:historical';
  const raw = {
    lease_id:leaseRef,
    work_ref:subjectKey,
    gate:'project_transition',
    run_id:'run-historical',
    status:'settled',
    created_at:'2026-09-12T18:00:00.000Z',
    expires_at:'2026-09-12T18:30:00.000Z',
    hard_expires_at:'2026-09-12T20:00:00.000Z',
    claim_idempotency_key:'project-transition:historical-acquire',
    claim_request_hash:'a'.repeat(64),
    claim_receipt:{
      schema:'project-transition-lease-claim-v1',
      subject:'project_transition',
      project_transition:{
        project_ref:'github:laurajoyhutchins/overcenter',
        transition_id:'historical',
        repository:'laurajoyhutchins/overcenter',
        authority_revision:'a'.repeat(40),
        authority_derivation:'overcenter-project-graph-v1',
        graph_fingerprint:'b'.repeat(64),
        transition_definition_fingerprint:'c'.repeat(64),
        transition_revision_fingerprint:'d'.repeat(64),
        transition_dependency_fingerprint:'e'.repeat(64),
        slot_key:subjectKey,
        authority_epoch:2,
      },
      execution_id:'execution:historical',
      operation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      intent_sha256:'f'.repeat(64),
    },
    settle_idempotency_key:'project-transition-settle:historical-settle',
    settle_plan:{ subject:'project_transition', disposition:'completed', evidence:[] },
    settle_receipt:{ schema:'project-transition-lease-settlement-v1', disposition:'completed', graph_revision_change:null },
    settled_at:'2026-09-12T18:20:00.000Z',
  };
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (String(sql).includes('FROM execution_state')) return { rows:[] };
      return { rows:[raw] };
    },
  };
  const store = (await import('../lib/project-transition-lease-store.js')).createProjectTransitionLeasePostgresStore(db);
  const lease = await store.getLease(leaseRef);
  assert.equal(lease?.status, 'settled');
  assert.equal(lease?.settlement_receipt?.schema, 'project-transition-lease-settlement-v1');
  assert.match(calls[0].sql, /FROM execution_state/);
  assert.match(calls[1].sql, /FROM work_leases/);
  calls.length = 0;
  const replay = await store.getLeaseByAcquireIdempotency('historical-acquire');
  assert.equal(replay?.lease_id, leaseRef);
  assert.equal(replay?.settle_idempotency_key, 'historical-settle');
  assert.match(calls[0].sql, /FROM execution_state/);
  assert.match(calls[1].sql, /FROM work_leases/);
  calls.length = 0;
  const latest = await store.getLatestSettledLeaseForTransition('github:laurajoyhutchins/overcenter', 'historical');
  assert.equal(latest?.lease_id, leaseRef);
  assert.equal(latest?.status, 'settled');
  assert.match(calls[0].sql, /FROM execution_state/);
  assert.match(calls[1].sql, /FROM work_leases/);
});

test('project-transition Postgres lease reads use canonical execution identity', async () => {
  const leaseRef = '99999999-9999-4999-8999-999999999999';
  const canonical = {
    lease_id:leaseRef,
    subject_key:'project_transition:canonical-read',
    subject_kind:'project_transition',
    execution_id:'execution:canonical-read',
    operation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    project_ref:'github:laurajoyhutchins/overcenter',
    transition_id:'ship',
    run_id:'run-canonical-read',
    lifecycle:'executing',
    settled:false,
    authority_epoch:4,
    authority_repository:'laurajoyhutchins/overcenter',
    authority_revision:'a'.repeat(40),
    authority_derivation:'overcenter-project-graph-v1',
    graph_fingerprint:'b'.repeat(64),
    transition_definition_fingerprint:'c'.repeat(64),
    transition_revision_fingerprint:'d'.repeat(64),
    transition_dependency_fingerprint:'e'.repeat(64),
    expires_at:'2026-09-12T20:30:00.000Z',
    hard_expires_at:'2026-09-12T23:00:00.000Z',
    idempotency_key:'canonical-acquire',
    intent_sha256:'f'.repeat(64),
    settlement_receipt:null,
  };
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows:[canonical] };
    },
  };
  const store = (await import('../lib/project-transition-lease-store.js')).createProjectTransitionLeasePostgresStore(db);
  const lease = await store.getLease(leaseRef);
  assert.equal(lease?.lease_id, leaseRef);
  assert.equal(lease?.status, 'active');
  assert.equal(lease?.subject, 'project_transition');
  assert.equal(lease?.authority_epoch, 4);
  assert.equal(lease?.transition_id, 'ship');
  assert.match(calls[0].sql, /FROM execution_state/);
  assert.doesNotMatch(calls[0].sql, /FROM work_leases/);
});
