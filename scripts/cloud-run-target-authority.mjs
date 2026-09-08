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

const DISARM_SOURCE_FREEZE_TRIGGERS = `DO $overcenter_target_activation$
DECLARE
  trigger_row record;
BEGIN
  FOR trigger_row IN
    SELECT namespace.nspname AS schema_name,
           relation.relname AS table_name,
           trigger.tgname AS trigger_name
      FROM pg_trigger AS trigger
      JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE NOT trigger.tgisinternal
       AND trigger.tgname LIKE 'overcenter_source_freeze_%'
  LOOP
    EXECUTE format(
      'DROP TRIGGER %I ON %I.%I',
      trigger_row.trigger_name,
      trigger_row.schema_name,
      trigger_row.table_name
    );
  END LOOP;
END
$overcenter_target_activation$;`;

const COUNT_SOURCE_FREEZE_TRIGGERS = `SELECT count(*)::text AS remaining
  FROM pg_trigger
 WHERE NOT tgisinternal
   AND tgname LIKE 'overcenter_source_freeze_%'`;

export async function activateAuthoritativeTarget({
  db,
  authorityMode,
  sourceRevision,
  sourceFreezeDigest,
} = {}) {
  if (authorityMode === 'shadow') return Object.freeze({ activated:false, reason:'shadow' });
  if (authorityMode !== 'authoritative') {
    throw failure('TARGET_ACTIVATION_AUTHORITY_MODE_INVALID', 'target activation requires shadow or authoritative authority mode', {
      authority_mode:authorityMode || null,
    });
  }
  if (!db || typeof db.query !== 'function') {
    throw failure('TARGET_ACTIVATION_DATABASE_REQUIRED', 'target activation requires PostgreSQL');
  }

  const revision = String(sourceRevision || '').trim().toLowerCase();
  const digest = String(sourceFreezeDigest || '').trim().toLowerCase();
  if (!SHA40.test(revision) || !SHA256.test(digest)) {
    throw failure('TARGET_ACTIVATION_IDENTITY_REQUIRED', 'authoritative target activation requires exact source revision and source freeze digest', {
      source_revision:revision || null,
      source_freeze_digest:digest || null,
    });
  }

  return withPinnedClient(db, async client => {
    await client.query('BEGIN');
    try {
      const freezeResult = await client.query(READ_FREEZE);
      const row = freezeResult?.rows?.[0] || null;
      const observedRevision = String(row?.source_revision || '').trim().toLowerCase();
      const observedDigest = String(row?.freeze_manifest_sha256 || '').trim().toLowerCase();
      if (
        !row
        || row.frozen !== true
        || !row.frozen_at
        || observedRevision !== revision
        || observedDigest !== digest
      ) {
        throw failure('TARGET_ACTIVATION_FREEZE_IDENTITY_MISMATCH', 'authoritative target does not contain the exact frozen source identity', {
          expected_source_revision:revision,
          observed_source_revision:observedRevision || null,
          expected_source_freeze_digest:digest,
          observed_source_freeze_digest:observedDigest || null,
          observed_frozen:row?.frozen === true,
          observed_frozen_at:row?.frozen_at || null,
        });
      }

      // Migration 059 is intentionally source-only. A migrated target contains its
      // durable freeze evidence, but must not retain the source database's write
      // rejection triggers after the control plane promotes it to sole authority.
      // Drop only triggers bearing that source-only prefix. The freeze row and its
      // irreversible guard remain intact as cutover evidence.
      await client.query(DISARM_SOURCE_FREEZE_TRIGGERS);
      const remainingResult = await client.query(COUNT_SOURCE_FREEZE_TRIGGERS);
      const remaining = Number(remainingResult?.rows?.[0]?.remaining ?? 0);
      if (!Number.isSafeInteger(remaining) || remaining !== 0) {
        throw failure('TARGET_ACTIVATION_SOURCE_FENCE_REMAINS', 'source-only database write fences remain armed on authoritative target', {
          remaining,
        });
      }

      await client.query('COMMIT');
      return Object.freeze({
        activated:true,
        source_frozen:true,
        source_revision:revision,
        source_freeze_digest:digest,
        source_freeze_triggers_remaining:0,
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  });
}
