import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCloudRunHandler,
  resolveCloudRunConfig,
} from './cloud-run-host.mjs';

function responseRecorder() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body += body;
    },
  };
}

async function request({ method = 'GET', url = '/', body = '' } = {}) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

test('resolveCloudRunConfig accepts Cloud SQL as ordinary Postgres socket configuration', () => {
  const config = resolveCloudRunConfig({
    PORT: '8080',
    PGHOST: '/cloudsql/project:us-west1:overcenter-postgres',
    PGDATABASE: 'overcenter',
    PGUSER: 'overcenter',
    PGPASSWORD: 'secret-value',
  });

  assert.deepEqual(config, {
    listenHost: '0.0.0.0',
    port: 8080,
    postgres: {
      host: '/cloudsql/project:us-west1:overcenter-postgres',
      database: 'overcenter',
      user: 'overcenter',
      password: 'secret-value',
    },
  });
});

test('resolveCloudRunConfig fails closed when Postgres credentials are incomplete', () => {
  assert.throws(
    () => resolveCloudRunConfig({
      PGHOST: '/cloudsql/project:us-west1:overcenter-postgres',
      PGDATABASE: 'overcenter',
      PGUSER: 'overcenter',
    }),
    error => error?.code === 'POSTGRES_CONFIG_REQUIRED'
      && error?.details?.missing?.includes('PGPASSWORD'),
  );
});

test('health checks the database before reporting ready', async () => {
  const queries = [];
  const handler = createCloudRunHandler({
    db: {
      async query(text) {
        queries.push(text);
        return { rows: [{ ok: 1 }] };
      },
    },
    runtime: { publishAndVerify: async () => { throw new Error('not called'); } },
  });
  const response = responseRecorder();

  await handler(await request({ url: '/health' }), response);

  assert.deepEqual(queries, ['SELECT 1 AS ok']);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    runtime: 'portable-node-postgres',
    database: 'ready',
  });
});

test('runtime publish preserves exact revision and artifact validation', async () => {
  const calls = [];
  const handler = createCloudRunHandler({
    db: { query: async () => ({ rows: [] }) },
    runtime: {
      async publishAndVerify(artifact, expectedFence) {
        calls.push({ artifact, expectedFence });
        return { deploymentRef: 'runtime:test', fence: 'fence:test' };
      },
    },
  });
  const sourceRevision = 'a'.repeat(40);
  const artifactDigest = `sha256:${'b'.repeat(64)}`;
  const response = responseRecorder();

  await handler(await request({
    method: 'POST',
    url: '/runtime/publish',
    body: JSON.stringify({ sourceRevision, artifactDigest, expectedFence: null }),
  }), response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(calls, [{ artifact: { sourceRevision, artifactDigest }, expectedFence: null }]);
  assert.deepEqual(JSON.parse(response.body), {
    ok: true,
    verified: { deploymentRef: 'runtime:test', fence: 'fence:test' },
  });
});
