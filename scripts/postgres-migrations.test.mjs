import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyPostgresMigrations, discoverPostgresMigrations } from './postgres-migrations.mjs';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'overcenter-migrations-'));
  await writeFile(join(dir, '002_second.sql'), 'CREATE TABLE second_table(id integer);\n');
  await writeFile(join(dir, '001_first.sql'), 'CREATE TABLE first_table(id integer);\n');
  return dir;
}

function fakeDb() {
  const applied = new Map();
  const executed = [];
  return {
    applied,
    executed,
    async query(text, params = []) {
      if (text.includes('CREATE TABLE IF NOT EXISTS overcenter_schema_migrations')) return { rows: [] };
      if (text.includes('SELECT sha256 FROM overcenter_schema_migrations')) {
        const sha256 = applied.get(params[0]);
        return { rows: sha256 ? [{ sha256 }] : [] };
      }
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        executed.push(text);
        return { rows: [] };
      }
      if (text.includes('INSERT INTO overcenter_schema_migrations')) {
        applied.set(params[0], params[1]);
        return { rows: [] };
      }
      executed.push(text);
      return { rows: [] };
    },
  };
}

test('discovers SQL migrations in deterministic filename order', async () => {
  const dir = await fixture();
  const migrations = await discoverPostgresMigrations(dir);
  assert.deepEqual(migrations.map(x => x.name), ['001_first.sql', '002_second.sql']);
  assert.match(migrations[0].sha256, /^[0-9a-f]{64}$/);
});

test('applies each migration exactly once and records its checksum', async () => {
  const dir = await fixture();
  const db = fakeDb();
  const first = await applyPostgresMigrations({ db, migrationsDir: dir });
  const second = await applyPostgresMigrations({ db, migrationsDir: dir });

  assert.deepEqual(first, { applied: ['001_first.sql', '002_second.sql'], skipped: [] });
  assert.deepEqual(second, { applied: [], skipped: ['001_first.sql', '002_second.sql'] });
  assert.equal(db.applied.size, 2);
});

test('fails closed if an already-applied migration changes bytes', async () => {
  const dir = await fixture();
  const db = fakeDb();
  await applyPostgresMigrations({ db, migrationsDir: dir });
  await writeFile(join(dir, '001_first.sql'), 'CREATE TABLE altered(id integer);\n');

  await assert.rejects(
    () => applyPostgresMigrations({ db, migrationsDir: dir }),
    error => error?.code === 'MIGRATION_CHECKSUM_MISMATCH' && error?.details?.migration === '001_first.sql',
  );
});
