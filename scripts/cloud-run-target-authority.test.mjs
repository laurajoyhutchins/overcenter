import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateAuthoritativeTarget,
  verifyAuthoritativeTarget,
} from './cloud-run-target-authority.mjs';

const runtimeRevision = 'a'.repeat(40);
const frozenSourceRevision = 'c'.repeat(40);
const freezeDigest = `sha256:${'b'.repeat(64)}`;

function dbWithFreeze({ remaining = ['0'], observedDigest = freezeDigest, dependents = [] } = {}) {
  const calls = [];
  let countRead = 0;
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (text.includes('FROM overcenter_authority_freeze')) {
        return { rows:[{
          frozen:true,
          frozen_at:'2026-09-08T12:00:00.000Z',
          source_revision:frozenSourceRevision,
          freeze_manifest_sha256:observedDigest,
        }] };
      }
      if (text.includes("tgname LIKE 'overcenter_source_freeze_%'") && text.includes('count(*)')) {
        const value = remaining[Math.min(countRead, remaining.length - 1)];
        countRead += 1;
        return { rows:[{ remaining:value }] };
      }
      if (text.includes('tgfoid') && text.includes('overcenter_reject_source_writes_when_frozen')) {
        return { rows:dependents.map(trigger_name => ({ trigger_name })) };
      }
      return { rows:[] };
    },
    release() {},
  };
  return { calls, db:{ connect:async () => client, query:client.query.bind(client) } };
}

test('runtime verification proves authoritative target identity without issuing DDL', async () => {
  const { calls, db } = dbWithFreeze();
  const result = await verifyAuthoritativeTarget({
    db,
    authorityMode:'authoritative',
    sourceRevision:runtimeRevision,
    sourceFreezeDigest:freezeDigest,
  });

  assert.equal(result.verified, true);
  assert.equal(result.source_frozen, true);
  assert.equal(result.source_freeze_triggers_remaining, 0);
  assert.ok(!calls.some(call => /DROP\s+(TRIGGER|FUNCTION)/i.test(call.text)));
  assert.ok(!calls.some(call => /UPDATE\s+overcenter_authority_freeze/i.test(call.text)));
});

test('runtime verification fails closed while copied source-only write fences remain', async () => {
  const { db } = dbWithFreeze({ remaining:['12'] });
  await assert.rejects(
    verifyAuthoritativeTarget({
      db,
      authorityMode:'authoritative',
      sourceRevision:runtimeRevision,
      sourceFreezeDigest:freezeDigest,
    }),
    error => error?.code === 'TARGET_ACTIVATION_SOURCE_FENCE_REMAINS'
      && error?.details?.remaining === 12
      && error?.may_have_mutated === false,
  );
});

test('deployment activation drops only the shared source-fence function and its proven trigger dependents', async () => {
  const dependents = [
    'overcenter_source_freeze_execution_state',
    'overcenter_source_freeze_orchestration_runs',
    'overcenter_source_freeze_work_leases',
  ];
  const { calls, db } = dbWithFreeze({ remaining:['3', '0'], dependents });
  const result = await activateAuthoritativeTarget({
    db,
    authorityMode:'authoritative',
    sourceRevision:runtimeRevision,
    sourceFreezeDigest:freezeDigest,
  });

  assert.equal(result.activated, true);
  assert.equal(result.source_frozen, true);
  assert.equal(result.source_freeze_triggers_remaining, 0);
  assert.ok(calls.some(call => /DROP FUNCTION\s+overcenter_reject_source_writes_when_frozen\(\)\s+CASCADE/i.test(call.text)));
  assert.ok(!calls.some(call => /DROP\s+TRIGGER/i.test(call.text)));
  assert.ok(!calls.some(call => /UPDATE\s+overcenter_authority_freeze/i.test(call.text)));
});

test('deployment activation fails closed if the shared function has any unexpected trigger dependent', async () => {
  const { calls, db } = dbWithFreeze({
    remaining:['1'],
    dependents:['overcenter_source_freeze_orchestration_runs', 'unrelated_trigger'],
  });

  await assert.rejects(
    activateAuthoritativeTarget({
      db,
      authorityMode:'authoritative',
      sourceRevision:runtimeRevision,
      sourceFreezeDigest:freezeDigest,
    }),
    error => error?.code === 'TARGET_ACTIVATION_DEPENDENCY_MISMATCH'
      && error?.may_have_mutated === false,
  );
  assert.ok(!calls.some(call => /DROP FUNCTION/i.test(call.text)));
});

test('deployment activation is idempotent when source-only trigger dependents are already gone', async () => {
  const { calls, db } = dbWithFreeze({ remaining:['0'] });
  const result = await activateAuthoritativeTarget({
    db,
    authorityMode:'authoritative',
    sourceRevision:runtimeRevision,
    sourceFreezeDigest:freezeDigest,
  });
  assert.equal(result.activated, true);
  assert.equal(result.source_freeze_triggers_remaining, 0);
  assert.ok(!calls.some(call => /DROP FUNCTION/i.test(call.text)));
});
