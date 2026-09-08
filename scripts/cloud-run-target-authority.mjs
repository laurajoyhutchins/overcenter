import { readFile } from 'node:fs/promises';

import { canonicalJson, sha256Text } from '../lib/canonical-json.js';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SOURCE_ONLY_MIGRATION = '059_authoritative_state_freeze.sql';
const RECOVERY_SEED_URL = new URL('../.overcenter/recovery/hatchable-cutover-v1.json', import.meta.url);

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    details:Object.freeze({ ...details, may_have_mutated:false }),
    may_have_mutated:false,
  });
}

async function withPinnedClient(db, operation) {
  if (typeof db.connect !== 'function') return operation(db);
  const client = await db.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

const READ_FRESH_EPOCH_STATE = `SELECT
  to_regclass('overcenter_authority_freeze')::text AS freeze_table,
  to_regprocedure('overcenter_reject_source_writes_when_frozen()')::text AS freeze_function,
  (SELECT count(*)::text
     FROM pg_trigger
    WHERE NOT tgisinternal
      AND tgname LIKE 'overcenter_source_freeze_%') AS freeze_triggers,
  (SELECT count(*)::text
     FROM overcenter_schema_migrations
    WHERE name=$1) AS source_only_migrations`;

function normalizeIdentity({ authorityMode, sourceRevision, sourceFreezeDigest }) {
  if (authorityMode !== 'authoritative') {
    throw failure('TARGET_ACTIVATION_AUTHORITY_MODE_INVALID', 'target authority proof requires authoritative mode', {
      authority_mode:authorityMode || null,
    });
  }
  const runtimeRevision = String(sourceRevision || '').trim().toLowerCase();
  const digest = String(sourceFreezeDigest || '').trim().toLowerCase();
  if (!SHA40.test(runtimeRevision) || !SHA256.test(digest)) {
    throw failure('TARGET_ACTIVATION_IDENTITY_REQUIRED', 'authoritative target proof requires exact runtime revision and source freeze digest', {
      runtime_source_revision:runtimeRevision || null,
      source_freeze_digest:digest || null,
    });
  }
  return { runtimeRevision, digest };
}

export async function verifyRecoverySeedProof(seed, expectedDigest) {
  const expected = String(expectedDigest || '').trim().toLowerCase();
  if (!SHA256.test(expected) || !seed || seed.schema !== 'overcenter-github-recovery-seed-v1') {
    throw failure('TARGET_ACTIVATION_RECOVERY_SEED_INVALID', 'sealed GitHub recovery seed is required');
  }
  const claimed = String(seed.digest || '').trim().toLowerCase();
  const body = { ...seed };
  delete body.digest;
  const computed = `sha256:${await sha256Text(canonicalJson(body))}`;
  if (claimed !== expected || computed !== expected) {
    throw failure('TARGET_ACTIVATION_RECOVERY_SEED_MISMATCH', 'GitHub recovery seed does not match the frozen-source digest', {
      expected_digest:expected,
      claimed_digest:claimed || null,
      computed_digest:computed,
    });
  }
  return Object.freeze({
    verified:true,
    digest:expected,
    project_ref:String(seed.project_ref || ''),
    repository:String(seed.repository || ''),
    transition_confirmations_count:Array.isArray(seed.transition_confirmations) ? seed.transition_confirmations.length : null,
  });
}

export async function readRecoverySeedProof(expectedDigest, seedUrl = RECOVERY_SEED_URL) {
  let seed;
  try {
    seed = JSON.parse(await readFile(seedUrl, 'utf8'));
  } catch (error) {
    throw failure('TARGET_ACTIVATION_RECOVERY_SEED_READ_FAILED', 'sealed GitHub recovery seed could not be read', {
      cause_code:error?.code || null,
    });
  }
  return verifyRecoverySeedProof(seed, expectedDigest);
}

function requireRecoverySeedProof(proof, digest) {
  if (proof?.verified !== true || String(proof?.digest || '').toLowerCase() !== digest) {
    throw failure('TARGET_ACTIVATION_RECOVERY_SEED_PROOF_REQUIRED', 'authoritative target requires verified GitHub recovery seed evidence', {
      expected_digest:digest,
      observed_digest:proof?.digest || null,
    });
  }
}

async function proveFreshTargetEpoch(client) {
  const result = await client.query(READ_FRESH_EPOCH_STATE, [SOURCE_ONLY_MIGRATION]);
  const row = result?.rows?.[0] || {};
  const triggerCount = Number(row.freeze_triggers ?? NaN);
  const migrationCount = Number(row.source_only_migrations ?? NaN);
  if (!Number.isSafeInteger(triggerCount) || !Number.isSafeInteger(migrationCount)) {
    throw failure('TARGET_ACTIVATION_FRESH_EPOCH_PROOF_INVALID', 'fresh target epoch state could not be counted', {
      freeze_triggers:row.freeze_triggers ?? null,
      source_only_migrations:row.source_only_migrations ?? null,
    });
  }
  if (row.freeze_table || row.freeze_function || triggerCount !== 0 || migrationCount !== 0) {
    throw failure('TARGET_ACTIVATION_SOURCE_EPOCH_STATE_PRESENT', 'source-only cutover control state must not cross into the fresh target epoch', {
      freeze_table:row.freeze_table || null,
      freeze_function:row.freeze_function || null,
      freeze_triggers:triggerCount,
      source_only_migrations:migrationCount,
    });
  }
  return Object.freeze({ source_freeze_triggers_remaining:0, source_only_migrations_present:0 });
}

async function proveAuthoritativeTarget({ db, identity, recoverySeedProof }) {
  requireRecoverySeedProof(recoverySeedProof, identity.digest);
  return withPinnedClient(db, async client => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const freshEpoch = await proveFreshTargetEpoch(client);
      await client.query('COMMIT');
      return Object.freeze({
        source_frozen:true,
        recovery_seed_verified:true,
        runtime_source_revision:identity.runtimeRevision,
        source_freeze_digest:identity.digest,
        ...freshEpoch,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

export async function verifyAuthoritativeTarget({
  db,
  authorityMode,
  sourceRevision,
  sourceFreezeDigest,
  recoverySeedProof,
} = {}) {
  if (authorityMode === 'shadow') return Object.freeze({ verified:false, reason:'shadow' });
  if (!db || typeof db.query !== 'function') {
    throw failure('TARGET_ACTIVATION_DATABASE_REQUIRED', 'target authority proof requires PostgreSQL');
  }
  const identity = normalizeIdentity({ authorityMode, sourceRevision, sourceFreezeDigest });
  const proof = await proveAuthoritativeTarget({ db, identity, recoverySeedProof });
  return Object.freeze({ verified:true, ...proof });
}

export async function activateAuthoritativeTarget({
  db,
  authorityMode,
  sourceRevision,
  sourceFreezeDigest,
  recoverySeedProof,
} = {}) {
  if (authorityMode === 'shadow') return Object.freeze({ activated:false, reason:'shadow' });
  if (!db || typeof db.query !== 'function') {
    throw failure('TARGET_ACTIVATION_DATABASE_REQUIRED', 'target activation requires PostgreSQL');
  }
  const identity = normalizeIdentity({ authorityMode, sourceRevision, sourceFreezeDigest });
  const proof = await proveAuthoritativeTarget({ db, identity, recoverySeedProof });
  return Object.freeze({ activated:true, ...proof });
}
