import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresOrchestrationMaintenanceStore } from '../lib/orchestration-runs.js';

test('maintenance replays a canonical project-transition settlement before legacy work leases', async () => {
  const calls = [];
  const receipt = {
    schema:'settlement-receipt-v1',
    execution_id:'execution-project-transition',
    operation_id:'operation-project-transition',
    settlement_idempotency_key:'settle-canonical',
    settlement_request_sha256:'request-canonical',
    authority_revision:'a'.repeat(40),
    authority_epoch:3,
    lifecycle:'settled',
    disposition:'completed',
    effect_ref:null,
    evidence_sha256:'b'.repeat(64),
  };
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM execution_state/i.test(sql)) return { rows:[{ receipt }] };
      if (/INSERT INTO orchestration_invocation_resolutions/i.test(sql)) {
        return { rows:[{ invocation_id:'invocation-canonical', resolution_kind:'externally_confirmed' }] };
      }
      if (/SELECT \* FROM orchestration_invocation_resolutions/i.test(sql)) return { rows:[] };
      if (/FROM work_leases/i.test(sql)) return { rows:[] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const result = await createPostgresOrchestrationMaintenanceStore(db).reconcileInvocation({
    invocation_id:'invocation-canonical',
    command:'work.settle',
    idempotency_key:'settle-canonical',
    request_sha256:'request-canonical',
    outcome:'indeterminate',
    may_have_mutated:true,
  });

  assert.deepEqual(result, {
    reconciled:true,
    command:'work.settle',
    resolution_kind:'externally_confirmed',
  });
  const canonicalIndex = calls.findIndex((call) => /FROM execution_state/i.test(call.sql));
  const legacyIndex = calls.findIndex((call) => /FROM work_leases/i.test(call.sql));
  assert.ok(canonicalIndex >= 0, 'canonical settlement receipt must be queried');
  assert.equal(legacyIndex, -1, 'legacy work lease receipt must not be consulted after canonical settlement is found');
});


test('legacy settlement replay excludes project-transition projection rows', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM execution_state/i.test(sql)) return { rows:[] };
      if (/FROM work_leases/i.test(sql)) {
        return {
          rows:[{
            receipt:{
              schema:'project-transition-lease-settlement-v1',
              disposition:'completed',
            },
            request_sha256:'request-canonical',
          }],
        };
      }
      if (/INSERT INTO orchestration_invocation_resolutions/i.test(sql)) {
        return { rows:[{ invocation_id:'invocation-projection', resolution_kind:'externally_confirmed' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const result = await createPostgresOrchestrationMaintenanceStore(db).reconcileInvocation({
    invocation_id:'invocation-projection',
    command:'work.settle',
    idempotency_key:'settle-canonical',
    request_sha256:'request-canonical',
    outcome:'indeterminate',
    may_have_mutated:true,
  });

  assert.equal(result, null);
  const legacyCall = calls.find((call) => /FROM work_leases/i.test(call.sql));
  assert.ok(legacyCall);
  assert.match(legacyCall.sql, /COALESCE\(claim_receipt->>'subject',''\)\s*<>\s*'project_transition'/i);
});
