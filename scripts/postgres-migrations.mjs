import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function fail(code, message, details = null) {
  throw Object.assign(new Error(message), { code, details });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

export async function discoverPostgresMigrations(migrationsDir, options = {}) {
  const excluded = new Set((options.excludeNames || []).map(String));
  const names = (await readdir(migrationsDir))
    .filter(name => /^\d+.*\.sql$/.test(name) && !excluded.has(name))
    .sort((a, b) => a.localeCompare(b));

  const migrations = [];
  for (const name of names) {
    const sql = await readFile(join(migrationsDir, name), 'utf8');
    migrations.push(Object.freeze({ name, sql, sha256: sha256(Buffer.from(sql, 'utf8')) }));
  }
  return Object.freeze(migrations);
}

export async function applyPostgresMigrations({ db, migrationsDir, excludeNames = [] }) {
  if (!db || typeof db.query !== 'function') {
    fail('MIGRATION_DATABASE_REQUIRED', 'PostgreSQL migration database is unavailable.');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS overcenter_schema_migrations (
      name text PRIMARY KEY,
      sha256 character(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = [];
  const skipped = [];
  for (const migration of await discoverPostgresMigrations(migrationsDir, { excludeNames })) {
    const existing = await db.query(
      'SELECT sha256 FROM overcenter_schema_migrations WHERE name=$1 LIMIT 1',
      [migration.name],
    );
    const observed = existing.rows?.[0]?.sha256 || null;
    if (observed) {
      if (observed !== migration.sha256) {
        fail(
          'MIGRATION_CHECKSUM_MISMATCH',
          `Applied migration ${migration.name} no longer matches source authority.`,
          { migration: migration.name, expected_sha256: observed, actual_sha256: migration.sha256 },
        );
      }
      skipped.push(migration.name);
      continue;
    }

    await withPinnedClient(db, async client => {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO overcenter_schema_migrations(name, sha256) VALUES ($1, $2)',
          [migration.name, migration.sha256],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw Object.assign(error, {
          migration: migration.name,
          migration_sha256: migration.sha256,
        });
      }
    });
    applied.push(migration.name);
  }

  return Object.freeze({ applied: Object.freeze(applied), skipped: Object.freeze(skipped) });
}
