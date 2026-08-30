import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createNodePostgresRuntime } from '../.portable-build/runtime/node-postgres-runtime.js';

const { Client } = pg;

function postgresClient() {
  return new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'overcenter',
    user: process.env.PGUSER || 'overcenter',
    password: process.env.PGPASSWORD || 'overcenter',
  });
}

test('ordinary Node and Postgres publish and verify provider-neutral runtime provenance', async () => {
  const source = await readFile(new URL('../src/runtime/node-postgres-runtime.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['\"]hatchable['\"]|from ['\"]@hatchable\//);

  const client = postgresClient();
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE overcenter_runtime_deployments (
        deployment_ref text PRIMARY KEY,
        source_revision text NOT NULL,
        artifact_digest text NOT NULL,
        fence text NOT NULL
      )
    `);

    const runtime = createNodePostgresRuntime(client);
    const artifact = {
      sourceRevision: '0123456789abcdef0123456789abcdef01234567',
      artifactDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    const verified = await runtime.publishAndVerify(artifact, null);
    assert.equal(verified.artifact.sourceRevision, artifact.sourceRevision);
    assert.equal(verified.observation.observedArtifactDigest, artifact.artifactDigest);
    assert.match(verified.observation.deploymentRef, /^runtime:/);

    await assert.rejects(
      runtime.publishAndVerify(artifact, 'stale-fence'),
      (error) => error?.code === 'RUNTIME_FENCE_MISMATCH',
    );
  } finally {
    await client.end();
  }
});