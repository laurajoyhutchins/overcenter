import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { createCloudRunHandler, resolveCloudRunConfig } from './cloud-run-host.mjs';
import { createCloudRunAuthorityProofInspector } from './cloud-run-authority-proof-runtime.mjs';
import { createCloudRunReadOnlyProjectInspector, createCloudRunSemanticWorker } from './cloud-run-semantic-runtime.mjs';
import { readRecoverySeedProof, verifyAuthoritativeTarget } from './cloud-run-target-authority.mjs';
import { applyPostgresMigrations, SOURCE_ONLY_POSTGRES_MIGRATIONS } from './postgres-migrations.mjs';

const config = resolveCloudRunConfig(process.env);
const { Pool } = pg;
const pool = new Pool(config.postgres);
const recoverySeedProof = await readRecoverySeedProof(process.env.OVERCENTER_SOURCE_FREEZE_DIGEST);

// Runtime startup must remain a read-only authority proof. Migration 059 is
// source-epoch cutover control state and is deliberately absent from canonical
// Cloud SQL. The serving process proves the sealed GitHub recovery seed matches
// the frozen-source digest and that no source-only fence machinery crossed the
// authority boundary before it performs any durable startup work.
const targetAuthority = await verifyAuthoritativeTarget({
  db:pool,
  authorityMode:config.authorityMode,
  sourceRevision:process.env.OVERCENTER_SOURCE_REVISION,
  sourceFreezeDigest:process.env.OVERCENTER_SOURCE_FREEZE_DIGEST,
  recoverySeedProof,
});
console.log(`Overcenter target authority: ${JSON.stringify(targetAuthority)}`);

const migrations = await applyPostgresMigrations({
  db: pool,
  migrationsDir: fileURLToPath(new URL('../migrations/', import.meta.url)),
  excludeNames:SOURCE_ONLY_POSTGRES_MIGRATIONS,
});
console.log(`Overcenter schema ready: ${migrations.applied.length} applied, ${migrations.skipped.length} already present.`);

await pool.query(`
  CREATE TABLE IF NOT EXISTS overcenter_runtime_deployments (
    deployment_ref text PRIMARY KEY,
    source_revision text NOT NULL,
    artifact_digest text NOT NULL,
    fence text NOT NULL
  )
`);

const { createNodePostgresRuntime, createNodePostgresTransactionExecutor } = await import(
  '../dist/portable/adapters/postgres/node-postgres-runtime.js'
);
const { createPostgresExecutionTransactionStore } = await import(
  '../dist/portable/adapters/postgres/execution-transaction-store.js'
);
const runtime = createNodePostgresRuntime(pool);
const executionTransactionStore = createPostgresExecutionTransactionStore(
  createNodePostgresTransactionExecutor(pool),
);
const workerCommand = createCloudRunSemanticWorker({
  db:pool,
  executionTransactionStore,
  env:process.env,
  logger:console,
});
const projectInspect = createCloudRunReadOnlyProjectInspector({ db:pool, env:process.env });
const authorityProofInspect = createCloudRunAuthorityProofInspector({ db:pool });
const handler = createCloudRunHandler({ db: pool, runtime, workerCommand, projectInspect, authorityProofInspect, authorityMode:config.authorityMode });
const server = createServer(handler);

server.listen(config.port, config.listenHost, () => {
  console.log(`Overcenter portable runtime listening on ${config.listenHost}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  await new Promise(resolve => server.close(resolve));
  await pool.end();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown(signal).finally(() => process.exit(0)));
}
