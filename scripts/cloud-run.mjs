import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { createCloudRunHandler, resolveCloudRunConfig } from './cloud-run-host.mjs';
import { createCloudRunReadOnlyProjectInspector, createCloudRunSemanticWorker } from './cloud-run-semantic-runtime.mjs';
import { applyPostgresMigrations, SOURCE_ONLY_POSTGRES_MIGRATIONS } from './postgres-migrations.mjs';

const config = resolveCloudRunConfig(process.env);
const { Pool } = pg;
const pool = new Pool(config.postgres);

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

const { createNodePostgresRuntime } = await import(
  '../dist/portable/adapters/postgres/node-postgres-runtime.js'
);
const runtime = createNodePostgresRuntime(pool);
const workerCommand = createCloudRunSemanticWorker({ db:pool, env:process.env, logger:console });
const projectInspect = createCloudRunReadOnlyProjectInspector({ db:pool, env:process.env });
const handler = createCloudRunHandler({ db: pool, runtime, workerCommand, projectInspect, authorityMode:config.authorityMode });
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
