import { createServer } from 'node:http';
import pg from 'pg';

import { createCloudRunHandler, resolveCloudRunConfig } from './cloud-run-host.mjs';

const config = resolveCloudRunConfig(process.env);
const { Pool } = pg;
const pool = new Pool(config.postgres);

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
const handler = createCloudRunHandler({ db: pool, runtime });
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
