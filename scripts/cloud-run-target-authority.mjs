const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

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

const READ_FREEZE = `SELECT frozen, frozen_at, source_revision, freeze_manifest_sha256
  FROM overcenter_authority_freeze
 WHERE singleton=true
 LIMIT 1
 FOR SHARE`;

const COUNT_SOURCE_FREEZE_TRIGGERS = `SELECT count(*)::text AS remaining
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgname LIKE 'overcenter_source_freeze_%'`;

const READ_SOURCE_FENCE_FUNCTION_DEPENDENTS = `SELECT t.tgname AS trigger_name
  FROM pg_trigger AS t
 WHERE NOT t.tgisinternal
   AND t.tgfoid = to_regprocedure('overcenter_reject_source_writes_when_frozen()')
 ORDER BY t.tgname`;

const DROP_SOURCE_FENCE_FUNCTION = `DROP FUNCTION overcenter_reject_source_writes_when_frozen() CASCADE`;

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

async function proveFreezeIdentity(client, { runtimeRevision, digest }) {
  const freezeResult = await client.query(READ_FREEZE);
  const row = freezeResult?.rows?.[0] || null;
  const frozenSourceRevision = String(row?.source_revision || '').trim().toLowerCase();
  const observedDigest = String(row?.freeze_manifest_sha256 || '').trim().toLowerCase();
  if (
    !row
    || row.frozen !== true
    || !row.frozen_at
    || !SHA40.test(frozenSourceRevision)
    || observedDigest !== digest
  ) {
    throw failure('TARGET_ACTIVATION_FREEZE_IDENTITY_MISMATCH', 'authoritative target does not contain the exact frozen-source evidence', {
      runtime_source_revision:runtimeRevision,
      frozen_source_revision:frozenSourceRevision || null,
      expected_source_freeze_digest:digest,
      observed_source_freeze_digest:observedDigest || null,
      observed_frozen:row?.frozen === true,
      observed_frozen_at:row?.frozen_at || null,
    });
  }
  return { frozenSourceRevision, observedDigest };
}

async function countSourceFreezeTriggers(client) {
  const result = await client.query(COUNT_SOURCE_FREEZE_TRIGGERS);
  const remaining = Number(result?.rows?.[0]?.remaining ?? NaN);
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw failure('TARGET_ACTIVATION_SOURCE_FENCE_COUNT_INVALID', 'could not prove copied source-only write fence count', {
      observed_remaining:result?.rows?.[0]?.remaining ?? null,
    });
  }
  return remaining;
}

async function proveSourceFenceFunctionOwnsExactlySourceTriggers(client, expectedCount) {
  const result = await client.query(READ_SOURCE_FENCE_FUNCTION_DEPENDENTS);
  const names = (result?.rows || []).map(row => String(row?.trigger_name || ''));
  const unexpected = names.filter(name => !name.startsWith('overcenter_source_freeze_'));
  if (names.length !== expectedCount || unexpected.length) {
    throw failure('TARGET_ACTIVATION_DEPENDENCY_MISMATCH', 'source fence function dependencies are not exactly the copied source-only triggers', {
      expected_source_trigger_count:expectedCount,
      observed_function_trigger_count:names.length,
      unexpected_trigger_names:unexpected,
    });
  }
  return names;
}

export async function verifyAuthoritativeTarget({
  db,
  authorityMode,
  sourceRevision,
  sourceFreezeDigest,
} = {}) {
  if (authorityMode === 'shadow') return Object.freeze({ verified:false, reason:'shadow' });
  if (!db || typeof db.query !== 'function') {
    throw failure('TARGET_ACTIVATION_DATABASE_REQUIRED', 'target authority proof requires PostgreSQL');
  }
  const identity = normalizeIdentity({ authorityMode, sourceRevision, sourceFreezeDigest });

  return withPinnedClient(db, async client => {
    await client.query('BEGIN');
    try {
      const { frozenSourceRevision } = await proveFreezeIdentity(client, identity);
      const remaining = await countSourceFreezeTriggers(client);
      if (remaining !== 0) {
        throw failure('TARGET_ACTIVATION_SOURCE_FENCE_REMAINS', 'source-only database write fences remain armed on authoritative target', {
          remaining,
        });
      }
      await client.query('COMMIT');
      return Object.freeze({
        verified:true,
        source_frozen:true,
        runtime_source_revision:identity.runtimeRevision,
        frozen_source_revision:frozenSourceRevision,
        source_freeze_digest:identity.digest,
        source_freeze_triggers_remaining:0,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}

export async function activateAuthoritativeTarget({
  db,
  authorityMode,
  sourceRevision,
  sourceFreezeDigest,
} = {}) {
  if (authorityMode === 'shadow') return Object.freeze({ activated:false, reason:'shadow' });
  if (!db || typeof db.query !== 'function') {
    throw failure('TARGET_ACTIVATION_DATABASE_REQUIRED', 'target activation requires PostgreSQL');
  }
  const identity = normalizeIdentity({ authorityMode, sourceRevision, sourceFreezeDigest });

  return withPinnedClient(db, async client => {
    await client.query('BEGIN');
    try {
      const { frozenSourceRevision } = await proveFreezeIdentity(client, identity);
      const before = await countSourceFreezeTriggers(client);

      if (before > 0) {
        // Migration 059 makes every source-only table fence depend on one trigger
        // function, while the immutable freeze-row guards use different functions.
        // Prove that dependency cone is exact before using CASCADE. Dropping the
        // source-only function requires function ownership rather than ownership of
        // every imported table, and PostgreSQL removes only the proven dependents.
        await proveSourceFenceFunctionOwnsExactlySourceTriggers(client, before);
        await client.query(DROP_SOURCE_FENCE_FUNCTION);
      }

      const remaining = await countSourceFreezeTriggers(client);
      if (remaining !== 0) {
        throw failure('TARGET_ACTIVATION_SOURCE_FENCE_REMAINS', 'source-only database write fences remain armed on authoritative target', {
          remaining,
        });
      }

      await client.query('COMMIT');
      return Object.freeze({
        activated:true,
        source_frozen:true,
        runtime_source_revision:identity.runtimeRevision,
        frozen_source_revision:frozenSourceRevision,
        source_freeze_digest:identity.digest,
        source_freeze_triggers_removed:before,
        source_freeze_triggers_remaining:0,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}
