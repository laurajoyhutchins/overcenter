import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = new URL('../', import.meta.url);
const cwd = fileURLToPath(root);
const { Client } = pg;

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    throw new Error(`${label} failed. ${result.error?.message || `exit ${result.status}`}`);
  }
}

if (process.env.OVERCENTER_DEV_SKIP_DOCKER !== '1') {
  run('docker', ['compose', 'up', '-d', 'postgres'], 'docker compose');
}

run(process.execPath, ['scripts/build.mjs', 'portable'], 'portable runtime build');
const { createNodePostgresRuntime } = await import('../dist/portable/adapters/postgres/node-postgres-runtime.js');

const client = new Client({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || 'overcenter',
  user: process.env.PGUSER || 'overcenter',
  password: process.env.PGPASSWORD || 'overcenter',
});

let connected = false;
for (let attempt = 0; attempt < 30 && !connected; attempt += 1) {
  try {
    await client.connect();
    connected = true;
  } catch (error) {
    if (attempt === 29) throw error;
    await delay(500);
  }
}

await client.query(`
  CREATE TABLE IF NOT EXISTS overcenter_runtime_deployments (
    deployment_ref text PRIMARY KEY,
    source_revision text NOT NULL,
    artifact_digest text NOT NULL,
    fence text NOT NULL
  )
`);

const runtime = createNodePostgresRuntime(client);
const port = Number(process.env.OVERCENTER_DEV_PORT || 8787);

async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function json(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      await client.query('SELECT 1');
      return json(response, 200, { ok: true, runtime: 'portable-node-postgres' });
    }
    if (request.method === 'POST' && request.url === '/runtime/publish') {
      const input = await body(request);
      if (!/^[0-9a-f]{40}$/i.test(input.sourceRevision || '')) {
        return json(response, 400, { ok: false, error: 'sourceRevision must be a 40-character Git SHA' });
      }
      if (!/^sha256:[0-9a-f]{64}$/i.test(input.artifactDigest || '')) {
        return json(response, 400, { ok: false, error: 'artifactDigest must be sha256:<64 hex>' });
      }
      const verified = await runtime.publishAndVerify(
        { sourceRevision: input.sourceRevision, artifactDigest: input.artifactDigest },
        input.expectedFence ?? null,
      );
      return json(response, 200, { ok: true, verified });
    }
    return json(response, 404, { ok: false, error: 'not found' });
  } catch (error) {
    return json(response, error.statusCode || 500, { ok: false, error: error.code || error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Overcenter portable dev runtime listening at http://127.0.0.1:${port}`);
  console.log('GET /health or POST /runtime/publish');
});

async function shutdown() {
  await new Promise(resolve => server.close(resolve));
  await client.end();
}
process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));