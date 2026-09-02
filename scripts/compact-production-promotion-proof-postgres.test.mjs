import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

import { createCompactProofStateStore } from '../lib/compact-proof-state-store.js';
import { persistExactProductionVerificationProof } from '../lib/github-production-verification-proof.js';

const { Client } = pg;
const root = new URL('../', import.meta.url);
const schema = 'compact_production_promotion_proof_test';

async function migration(name) {
  return readFile(new URL(`migrations/${name}`, root), 'utf8');
}

function clientForPostgres() {
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

const normalized = Object.freeze({
  repo:'laurajoyhutchins/overcenter',
  candidate_sha:'1'.repeat(40),
  observed_development_head:'1'.repeat(40),
  observed_production_head:'2'.repeat(40),
  verification_run_id:1234,
  idempotency_key:'promotion-proof-test',
});
const roles = Object.freeze({ development_branch:'dev', production_branch:'main' });
const run = Object.freeze({
  id:1234,
  path:'.github/workflows/exact-revision-v8.yml',
  event:'push',
  head_branch:'dev',
  head_sha:'1'.repeat(40),
  status:'completed',
  conclusion:'success',
  html_url:'https://github.com/laurajoyhutchins/overcenter/actions/runs/1234',
});

test('production verification becomes an exact-revision proof without verification history tables', async () => {
  const client = clientForPostgres();
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(await migration('055_proof_state.sql'));
    assert.equal((await client.query(`SELECT to_regclass('portfolio_verification_receipts') AS receipts`)).rows[0].receipts, null);

    const proofs = createCompactProofStateStore(binding(client));
    const proof = await persistExactProductionVerificationProof({
      proofs,
      normalized,
      branchRoles:roles,
      workflowRun:run,
      observedAt:'2026-09-01T22:00:00.000Z',
    });
    assert.equal(proof.subject_key, 'repository:laurajoyhutchins/overcenter');
    assert.equal(proof.predicate_kind, 'exact_revision_v8_satisfied');
    assert.equal(proof.authority_revision, normalized.candidate_sha);

    const exact = await proofs.findSatisfied({
      subject_key:proof.subject_key,
      predicate_kind:proof.predicate_kind,
      authority_repository:normalized.repo,
      authority_revision:normalized.candidate_sha,
    });
    assert.equal(exact?.proof_key, proof.proof_key);

    const stale = await proofs.findSatisfied({
      subject_key:proof.subject_key,
      predicate_kind:proof.predicate_kind,
      authority_repository:normalized.repo,
      authority_revision:'3'.repeat(40),
    });
    assert.equal(stale, null);

    await assert.rejects(
      persistExactProductionVerificationProof({
        proofs,
        normalized,
        branchRoles:roles,
        workflowRun:{ ...run, head_sha:'4'.repeat(40) },
        observedAt:'2026-09-01T22:01:00.000Z',
      }),
      error => error?.code === 'GITHUB_PRODUCTION_PROMOTION_VERIFICATION_REQUIRED',
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
