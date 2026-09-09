import { createServer } from 'node:http';
import pg from 'pg';

import { resolveCloudRunConfig } from './cloud-run-host.mjs';
import { createCloudRunAuthorityProofInspector } from './cloud-run-authority-proof-runtime.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const config = resolveCloudRunConfig(process.env);
const { Pool } = pg;
const pool = new Pool(config.postgres);
const inspect = createCloudRunAuthorityProofInspector({ db:pool });

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('request body too large'), { statusCode:413, code:'REQUEST_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode:400, code:'REQUEST_INVALID' });
  }
}

function writeJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type':'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(value)}\n`);
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      await pool.query('SELECT 1 AS ok');
      return writeJson(response, 200, { ok:true, database:'ready', mode:'read-only-authority-proof' });
    }
    if (request.method === 'POST' && request.url === '/inspect') {
      const input = await readJsonBody(request);
      const proof = await inspect(input);
      return writeJson(response, 200, { ok:true, proof });
    }
    return writeJson(response, 404, { ok:false, error:'not found' });
  } catch (error) {
    return writeJson(response, error?.statusCode || 500, {
      ok:false,
      error:error?.code || 'AUTHORITY_PROOF_INSPECT_FAILED',
      message:error?.message || 'authority proof inspection failed',
    });
  }
});

server.listen(config.port, config.listenHost, () => {
  console.log(`Overcenter read-only authority proof inspector listening on ${config.listenHost}:${config.port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down read-only authority proof inspector.`);
  await new Promise(resolve => server.close(resolve));
  await pool.end();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown(signal).finally(() => process.exit(0)));
}
