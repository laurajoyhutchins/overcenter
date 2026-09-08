import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activateAuthoritativeTarget,
  verifyAuthoritativeTarget,
} from './cloud-run-target-authority.mjs';

const runtimeRevision = 'a'.repeat(40);
const frozenSourceRevision = 'c'.repeat(40);
const freezeDigest = `sha256:${'b'.repeat(64)}`;

function dbWithFreeze({ remaining = '0', observedDigest = freezeDigest } = {}) {
  const calls = [];
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
      if (text.includes("tgname LIKE 'overcenter_source_freeze_%'")) {
        return { rows:[{ remaining }] };
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
  assert.ok(!calls.some(call => /DROP\s+TRIGGER/i.test(call.text)));
  assert.ok(!calls.some(call => /UPDATE\s+overcenter_authority_freeze/i.test(call.text)));
});

test('runtime verification fails closed while copied source-only write fences remain', async () => {
  const { db } = dbWithFreeze({ remaining:'12' });
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

test('deployment activation removes only copied source-freeze triggers and preserves freeze evidence', async () => {
  const { calls, db } = dbWithFreeze();
  const result = await activateAuthoritativeTarget({
    db,
    authorityMode:'authoritative',
    sourceRevision:runtimeRevision,
    sourceFreezeDigest:freezeDigest,
  });

  assert.equal(result.activated, true);
  assert.equal(result.source_frozen, true);
  assert.equal(result.source_freeze_triggers_remaining, 0);
  assert.ok(calls.some(call => call.text.includes("tgname LIKE 'overcenter_source_freeze_%'") && call.text.includes('DROP TRIGGER')));
  assert.ok(!calls.some(call => /UPDATE\s+overcenter_authority_freeze/i.test(call.text)));
});
