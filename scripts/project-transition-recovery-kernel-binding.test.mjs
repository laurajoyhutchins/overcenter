import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPostgresOrchestrationRecoveryStore } from '../lib/orchestration-recovery.js';
import { createOrchestrationRunService } from '../lib/orchestration-runs.js';
import { durableLeaseSubject } from '../lib/orchestration-lease-authority.js';

test('orchestration recovery selects only nonterminal canonical executions', async () => {
  const calls = [];
  const store = createPostgresOrchestrationRecoveryStore({
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows:[] };
    },
  });

  await store.currentExecution('run-project-transition');
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /lifecycle IN \('prepared', 'executing', 'effect_uncertain', 'effect_confirmed', 'effect_absent'\)/);
  assert.match(calls[0].sql, /settled\s*=\s*false/);
});


test('orchestration finish returns the canonical transition settlement receipt', async () => {
  const receipt = {
    schema:'settlement-receipt-v1',
    execution_id:'execution:finish-receipt',
    operation_id:'33333333-3333-4333-8333-333333333333',
    authority_revision:'a'.repeat(40),
    authority_epoch:4,
    lifecycle:'settled',
    disposition:'completed',
    effect_ref:null,
    evidence_sha256:'b'.repeat(64),
  };
  const run = {
    run_id:'run-finish-receipt',
    status:'active',
    worker:'Fast Forward',
    mode:'interactive',
    started_at:'2026-09-12T20:00:00.000Z',
    deadline_at:'2026-09-12T22:00:00.000Z',
  };
  const service = createOrchestrationRunService({
    store:{
      async getRun() { return run; },
      async activeLeaseForRun() {
        return {
          lease_id:'44444444-4444-4444-8444-444444444444',
          work_ref:'project_transition:finish',
          gate:'project_transition',
          run_id:run.run_id,
          status:'active',
          expires_at:'2026-09-12T21:00:00.000Z',
        };
      },
      async finishRun(_runId, patch) {
        Object.assign(run, patch);
        return run;
      },
      async leasesForRun() { return []; },
      async invocationsForRun() { return []; },
    },
    leases:{
      async settleByRef() {
        return { ok:true, status:'settled', disposition:'completed', settlement_receipt:receipt };
      },
    },
    now:() => '2026-09-12T20:30:00.000Z',
  });
  const result = await service.finish({
    run_id:run.run_id,
    disposition:'clean-stop',
    active_lease_settlement:{ disposition:'completed', evidence:[] },
  });
  assert.deepEqual(result.settlement_receipt, receipt);
});


test('orchestration run receipts project the canonical transition settlement receipt', async () => {
  const receipt = {
    schema:'settlement-receipt-v1',
    execution_id:'execution:run-receipt',
    operation_id:'55555555-5555-4555-8555-555555555555',
    authority_revision:'a'.repeat(40),
    authority_epoch:5,
    lifecycle:'settled',
    disposition:'completed',
    effect_ref:null,
    evidence_sha256:'b'.repeat(64),
  };
  const service = createOrchestrationRunService({
    store:{
      async getRun() {
        return {
          run_id:'run-canonical-receipt',
          status:'finished',
          disposition:'clean-stop',
          started_at:'2026-09-12T20:00:00.000Z',
          finished_at:'2026-09-12T20:30:00.000Z',
        };
      },
      async leasesForRun() {
        return [{
          lease_id:'66666666-6666-4666-8666-666666666666',
          work_ref:'project_transition:receipt',
          gate:'project_transition',
          status:'settled',
          created_at:'2026-09-12T20:10:00.000Z',
          settled_at:'2026-09-12T20:30:00.000Z',
          settle_plan:{ evidence:[] },
          settle_receipt:{ canonical_receipt:receipt },
        }];
      },
      async invocationsForRun() { return []; },
    },
  });
  const result = await service.receipt({ run_id:'run-canonical-receipt' });
  assert.deepEqual(result.settlements[0]?.canonical_receipt, receipt);
});


test('production subject-aware finish requires a canonical project-transition receipt', async () => {
  const service = (await import('../lib/orchestration-finish-runtime.js')).createSubjectAwareLeaseSettlementService({
    requireCanonicalReceipt:true,
    readLease:async () => ({
      lease_id:'77777777-7777-4777-8777-777777777777',
      run_id:'run-canonical-required',
      gate:'project_transition',
      claim_receipt:{ subject:'project_transition' },
    }),
    legacyLeases:{ async settleByRef() { throw new Error('legacy settlement was selected'); } },
    projectTransitions:{ async settle() { return { ok:true, status:'settled', disposition:'completed' }; } },
  });
  await assert.rejects(
    service.settleByRef({
      lease_ref:'77777777-7777-4777-8777-777777777777',
      disposition:'completed',
      evidence:[],
      idempotency_key:'canonical-required',
    }),
    error => error?.code === 'CANONICAL_SETTLEMENT_RECEIPT_REQUIRED',
  );
});


test('subject-aware orchestration candidates are fenced by canonical execution lifecycle', async () => {
  const source = await readFile(new URL('../lib/orchestration-finish-runtime.js', import.meta.url), 'utf8');
  const start = source.indexOf('function readActiveLeaseCandidates');
  const end = source.indexOf('export function createPostgresSubjectAwareOrchestrationRunService', start);
  const candidates = source.slice(start, end);
  assert.match(candidates, /JOIN execution_state/);
  assert.match(candidates, /e\.lifecycle IN/);
  assert.match(candidates, /e\.settled\s*=\s*false/);
});


test('subject routing rejects canonical and projection subject disagreement', () => {
  assert.throws(
    () => durableLeaseSubject({
      lease_id:'88888888-8888-4888-8888-888888888888',
      subject_kind:'legacy_work',
      gate:'project_transition',
      claim_receipt:{ subject:'project_transition' },
    }),
    error => error?.code === 'ORCHESTRATION_LEASE_SUBJECT_INVALID',
  );
});
