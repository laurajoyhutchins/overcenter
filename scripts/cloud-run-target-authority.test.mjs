import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson, sha256Text } from '../lib/canonical-json.js';
import {
  activateAuthoritativeTarget,
  verifyAuthoritativeTarget,
  verifyRecoverySeedProof,
} from './cloud-run-target-authority.mjs';

const runtimeRevision = 'a'.repeat(40);

async function sealedSeed() {
  const body = {
    schema:'overcenter-github-recovery-seed-v1',
    project_ref:'github:laurajoyhutchins/overcenter',
    repository:'laurajoyhutchins/overcenter',
    transition_confirmations:[],
    repository_branch_roles:[],
    repository_dispositions:[],
    source_coordinates:{
      transition_confirmations_count:0,
      transition_confirmations_max_settled_at:null,
      branch_roles_count:0,
      branch_roles_max_updated_at:null,
      repository_dispositions_count:0,
      repository_dispositions_max_updated_at:null,
    },
  };
  const digest = `sha256:${await sha256Text(canonicalJson(body))}`;
  return { seed:{ ...body, digest }, digest };
}

function freshEpochDb({ freezeTable = null, freezeFunction = null, freezeTriggers = '0', sourceOnlyMigrations = '0' } = {}) {
  const calls = [];
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (text.includes("to_regclass('overcenter_authority_freeze')")) {
        return { rows:[{
          freeze_table:freezeTable,
          freeze_function:freezeFunction,
          freeze_triggers:freezeTriggers,
          source_only_migrations:sourceOnlyMigrations,
        }] };
      }
      return { rows:[] };
    },
    release() {},
  };
  return { calls, db:{ connect:async () => client, query:client.query.bind(client) } };
}

async function authorityInput(db) {
  const { seed, digest } = await sealedSeed();
  const recoverySeedProof = await verifyRecoverySeedProof(seed, digest);
  return {
    db,
    authorityMode:'authoritative',
    sourceRevision:runtimeRevision,
    sourceFreezeDigest:digest,
    recoverySeedProof,
  };
}

test('sealed recovery seed proof recomputes the digest and rejects tampering', async () => {
  const { seed, digest } = await sealedSeed();
  const proof = await verifyRecoverySeedProof(seed, digest);
  assert.equal(proof.verified, true);
  assert.equal(proof.digest, digest);

  await assert.rejects(
    verifyRecoverySeedProof({ ...seed, repository:'laurajoyhutchins/not-overcenter' }, digest),
    error => error?.code === 'TARGET_ACTIVATION_RECOVERY_SEED_MISMATCH'
      && error?.may_have_mutated === false,
  );
});

test('runtime verification proves fresh target epoch without DDL', async () => {
  const { calls, db } = freshEpochDb();
  const result = await verifyAuthoritativeTarget(await authorityInput(db));

  assert.equal(result.verified, true);
  assert.equal(result.source_frozen, true);
  assert.equal(result.recovery_seed_verified, true);
  assert.equal(result.source_freeze_triggers_remaining, 0);
  assert.equal(result.source_only_migrations_present, 0);
  assert.ok(calls.some(call => /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/i.test(call.text)));
  assert.ok(!calls.some(call => /\b(DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(call.text)));
});

test('runtime verification fails closed if source-only freeze table crossed epochs', async () => {
  const { db } = freshEpochDb({ freezeTable:'overcenter_authority_freeze' });
  await assert.rejects(
    verifyAuthoritativeTarget(await authorityInput(db)),
    error => error?.code === 'TARGET_ACTIVATION_SOURCE_EPOCH_STATE_PRESENT'
      && error?.details?.freeze_table === 'overcenter_authority_freeze'
      && error?.may_have_mutated === false,
  );
});

test('runtime verification fails closed if migration 059 was applied on target', async () => {
  const { db } = freshEpochDb({ sourceOnlyMigrations:'1' });
  await assert.rejects(
    verifyAuthoritativeTarget(await authorityInput(db)),
    error => error?.code === 'TARGET_ACTIVATION_SOURCE_EPOCH_STATE_PRESENT'
      && error?.details?.source_only_migrations === 1
      && error?.may_have_mutated === false,
  );
});

test('deployment activation is the same read-only fresh-epoch proof', async () => {
  const { calls, db } = freshEpochDb();
  const result = await activateAuthoritativeTarget(await authorityInput(db));
  assert.equal(result.activated, true);
  assert.equal(result.recovery_seed_verified, true);
  assert.equal(result.source_freeze_triggers_remaining, 0);
  assert.ok(!calls.some(call => /\b(DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(call.text)));
});

test('authority proof requires the recovery seed digest bound to the source freeze', async () => {
  const { db } = freshEpochDb();
  const { seed, digest } = await sealedSeed();
  const recoverySeedProof = await verifyRecoverySeedProof(seed, digest);
  await assert.rejects(
    verifyAuthoritativeTarget({
      db,
      authorityMode:'authoritative',
      sourceRevision:runtimeRevision,
      sourceFreezeDigest:`sha256:${'f'.repeat(64)}`,
      recoverySeedProof,
    }),
    error => error?.code === 'TARGET_ACTIVATION_RECOVERY_SEED_PROOF_REQUIRED'
      && error?.may_have_mutated === false,
  );
});
