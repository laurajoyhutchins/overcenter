import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import pg from 'pg';
import { applyMigrations, introspectPostgresContracts } from './postgres-discoverer.mjs';

const { Client } = pg;

function client() {
  return new Client({
    host:process.env.PGHOST || '127.0.0.1',
    port:Number(process.env.PGPORT || 5432),
    database:process.env.PGDATABASE || 'overcenter',
    user:process.env.PGUSER || 'overcenter',
    password:process.env.PGPASSWORD || 'overcenter',
  });
}

test('final migrated PostgreSQL schema is authority, not migration history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'contract-postgres-'));
  const migrations = join(root, 'migrations');
  await mkdir(migrations, { recursive:true });
  await writeFile(join(migrations, '001_create_example.sql'), `
CREATE TYPE example_status AS ENUM ('ready', 'done');
CREATE TABLE example_contract (
  id text PRIMARY KEY,
  status example_status NOT NULL DEFAULT 'ready',
  payload jsonb NOT NULL,
  obsolete text
);
`, 'utf8');
  await writeFile(join(migrations, '002_alter_example.sql'), `
ALTER TABLE example_contract DROP COLUMN obsolete;
ALTER TABLE example_contract ADD CONSTRAINT example_payload_object CHECK (jsonb_typeof(payload) = 'object');
CREATE VIEW example_contract_view AS SELECT id, status FROM example_contract;
`, 'utf8');

  const db = client();
  await db.connect();
  try {
    await db.query('DROP VIEW IF EXISTS example_contract_view CASCADE');
    await db.query('DROP TABLE IF EXISTS example_contract CASCADE');
    await db.query('DROP TYPE IF EXISTS example_status CASCADE');
    await applyMigrations(db, migrations);
    const candidates = await introspectPostgresContracts(db);
    const ids = candidates.map((item) => item.source_identity);
    assert.ok(ids.includes('postgres:public.example_contract#table'));
    assert.ok(ids.includes('postgres:public.example_contract#id'));
    assert.ok(ids.includes('postgres:public.example_contract#payload'));
    assert.equal(ids.includes('postgres:public.example_contract#obsolete'), false);
    assert.ok(ids.includes('postgres:public.example_status#type'));
    assert.ok(ids.includes('postgres:public.example_contract_view#view'));
    assert.ok(ids.includes('postgres:public.example_contract#constraint:example_payload_object'));
    const payload = candidates.find((item) => item.source_identity === 'postgres:public.example_contract#payload');
    assert.equal(payload.structure.data_type, 'jsonb');
    assert.equal(payload.structure.nullable, false);
    assert.deepEqual(ids, [...ids].sort());
  } finally {
    await db.query('DROP VIEW IF EXISTS example_contract_view CASCADE').catch(() => {});
    await db.query('DROP TABLE IF EXISTS example_contract CASCADE').catch(() => {});
    await db.query('DROP TYPE IF EXISTS example_status CASCADE').catch(() => {});
    await db.end();
    await rm(root, { recursive:true, force:true });
  }
});
