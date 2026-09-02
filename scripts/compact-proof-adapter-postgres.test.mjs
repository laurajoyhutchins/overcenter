import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import { createNodePostgresTransactionExecutor } from '../dist/portable/adapters/postgres/node-postgres-runtime.js';
import { createPostgresCompactExecutionStateStore } from '../dist/portable/adapters/postgres/compact-execution-state-store.js';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'compact_proof_adapter_test';

function postgresClient() {
  return new Client({
    host:process.env.PGHOST || '127.0.0.1',
    port:Number(process.env.PGPORT || 5432),
    database:process.env.PGDATABASE || 'overcenter',
    user:process.env.PGUSER || 'overcenter',
    password:process.env.PGPASSWORD || 'overcenter',
  });
}

async function migration(name) {
  return readFile(new URL(`migrations/${name}`, root), 'utf8');
}

test('canonical compact adapter treats proof identity as immutable', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(await migration('055_proof_state.sql'));

    const store = createPostgresCompactExecutionStateStore(createNodePostgresTransactionExecutor(client));
    const proof = {
      proof_key:'exact-v8:repository:overcenter:sha-x',
      subject_key:'repository:laurajoyhutchins/overcenter',
      predicate_kind:'exact_revision_v8_verified',
      authority_repository:'laurajoyhutchins/overcenter',
      authority_revision:'1'.repeat(40),
      evidence_sha256:'a'.repeat(64),
      evidence_refs:[{ kind:'github-workflow-run', ref:'run:123' }],
      satisfied_at:'2026-09-01T20:45:00.000Z',
      consumed_at:null,
    };

    const first = await store.putProof(proof);
    assert.equal(first.authority_revision, proof.authority_revision);
    const replay = await store.putProof(proof);
    assert.equal(replay.evidence_sha256, proof.evidence_sha256);

    await assert.rejects(
      store.putProof({ ...proof, authority_revision:'2'.repeat(40) }),
      error => error?.code === 'PROOF_IDENTITY_CONFLICT',
    );
    await assert.rejects(
      store.putProof({ ...proof, evidence_sha256:'b'.repeat(64) }),
      error => error?.code === 'PROOF_IDENTITY_CONFLICT',
    );

    const persisted = await store.getProof(proof.proof_key);
    assert.equal(persisted.authority_revision, proof.authority_revision);
    assert.equal(persisted.evidence_sha256, proof.evidence_sha256);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
