import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import { createCompactProofStateStore } from '../lib/compact-proof-state-store.js';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'compact_proof_state_test';

async function migration(name) {
  return readFile(new URL(`migrations/${name}`, root), 'utf8');
}

function postgresClient() {
  return new Client({
    host:process.env.PGHOST || '127.0.0.1',
    port:Number(process.env.PGPORT || 5432),
    database:process.env.PGDATABASE || 'overcenter',
    user:process.env.PGUSER || 'overcenter',
    password:process.env.PGPASSWORD || 'overcenter',
  });
}

function binding(client) {
  return { query:(text, values) => client.query(text, values) };
}

async function prepareSchema(client) {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}, public`);
  await client.query(await migration('055_proof_state.sql'));
}

test('proof state is exact-revision authority and does not need portfolio_verification_receipts or execution state', async () => {
  const client = postgresClient();
  await client.connect();
  try {
    await prepareSchema(client);
    const oldTables = await client.query(`SELECT to_regclass('portfolio_verification_receipts') AS receipts, to_regclass('execution_state') AS execution`);
    assert.equal(oldTables.rows[0].receipts, null);
    assert.equal(oldTables.rows[0].execution, null);

    const store = createCompactProofStateStore(binding(client));
    const proof = {
      proof_key:'required-checks:laurajoyhutchins/overcenter:sha-x',
      subject_key:'repository:laurajoyhutchins/overcenter',
      predicate_kind:'required_checks_satisfied',
      authority_repository:'laurajoyhutchins/overcenter',
      authority_revision:'1111111111111111111111111111111111111111',
      evidence_sha256:'a'.repeat(64),
      evidence_refs:[{ kind:'github-check-run', ref:'check-run:123' }],
      satisfied_at:'2026-09-01T20:30:00.000Z',
    };

    const inserted = await store.satisfy(proof);
    assert.equal(inserted.authority_revision, proof.authority_revision);
    assert.deepEqual(inserted.evidence_refs, proof.evidence_refs);

    const replay = await store.satisfy(proof);
    assert.equal(replay.proof_key, proof.proof_key);

    const exact = await store.findSatisfied({
      subject_key:proof.subject_key,
      predicate_kind:proof.predicate_kind,
      authority_repository:proof.authority_repository,
      authority_revision:proof.authority_revision,
    });
    assert.equal(exact?.proof_key, proof.proof_key);

    const wrongRevision = await store.findSatisfied({
      subject_key:proof.subject_key,
      predicate_kind:proof.predicate_kind,
      authority_repository:proof.authority_repository,
      authority_revision:'2222222222222222222222222222222222222222',
    });
    assert.equal(wrongRevision, null);

    await assert.rejects(
      store.satisfy({ ...proof, authority_revision:'2222222222222222222222222222222222222222' }),
      error => error?.code === 'PROOF_IDENTITY_CONFLICT',
    );
    await assert.rejects(
      store.satisfy({ ...proof, evidence_sha256:'b'.repeat(64) }),
      error => error?.code === 'PROOF_IDENTITY_CONFLICT',
    );

    const consumed = await store.consume({
      proof_key:proof.proof_key,
      authority_repository:proof.authority_repository,
      authority_revision:proof.authority_revision,
      consumed_at:'2026-09-01T20:31:00.000Z',
    });
    assert.equal(consumed?.consumed_at, '2026-09-01T20:31:00.000Z');

    const afterConsume = await store.findSatisfied({
      subject_key:proof.subject_key,
      predicate_kind:proof.predicate_kind,
      authority_repository:proof.authority_repository,
      authority_revision:proof.authority_revision,
    });
    assert.equal(afterConsume, null);

    const fetched = await store.get(proof.proof_key);
    assert.equal(fetched?.consumed_at, '2026-09-01T20:31:00.000Z');

    const stillAbsent = await client.query(`SELECT to_regclass('portfolio_verification_receipts') AS receipts, to_regclass('execution_state') AS execution`);
    assert.equal(stillAbsent.rows[0].receipts, null);
    assert.equal(stillAbsent.rows[0].execution, null);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
