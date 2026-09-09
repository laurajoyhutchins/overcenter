import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCloudRunHandler,
  resolveCloudRunConfig,
} from './cloud-run-host.mjs';
import { createCloudRunDatabaseBinding } from './cloud-run-database-binding.mjs';

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
    OVERCENTER_AUTHORITY_MODE: 'shadow',
  });

  assert.deepEqual(config, {
    listenHost: '0.0.0.0',
    port: 8080,
    authorityMode: 'shadow',
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

test('Cloud Run Postgres binding supplies ordered atomic transactions over pg Pool', async () => {
  const events = [];
  const pool = {
    async query(sql, params) {
      events.push(['pool', sql, params]);
      return { rows:[{ direct:true }] };
    },
    async connect() {
      return {
        async query(sql, params) {
          events.push(['client', sql, params]);
          if (sql === 'SELECT one') return { rows:[{ value:1 }] };
          if (sql === 'SELECT two') return { rows:[{ value:2 }] };
          return { rows:[] };
        },
        release() { events.push(['release']); },
      };
    },
  };
  const db = createCloudRunDatabaseBinding(pool);
  const direct = await db.query('SELECT direct', ['x']);
  const transaction = await db.transaction([
    { sql:'SELECT one', params:['a'] },
    { sql:'SELECT two', params:['b'] },
  ]);

  assert.deepEqual(direct.rows, [{ direct:true }]);
  assert.deepEqual(transaction.results.map(result => result.rows), [[{ value:1 }], [{ value:2 }]]);
  assert.deepEqual(events, [
    ['pool', 'SELECT direct', ['x']],
    ['client', 'BEGIN', undefined],
    ['client', 'SELECT one', ['a']],
    ['client', 'SELECT two', ['b']],
    ['client', 'COMMIT', undefined],
    ['release'],
  ]);
});

test('Cloud Run Postgres binding proves rollback-success failures did not durably mutate', async () => {
  const events = [];
  const expected = Object.assign(new Error('lease insert failed'), { code:'23505' });
  const pool = {
    async query() { return { rows:[] }; },
    async connect() {
      return {
        async query(sql) {
          events.push(sql);
          if (sql === 'INSERT lease') throw expected;
          return { rows:[] };
        },
        release() { events.push('RELEASE'); },
      };
    },
  };
  const db = createCloudRunDatabaseBinding(pool);
  await assert.rejects(
    db.transaction([{ sql:'INSERT lease', params:[] }]),
    error => error === expected && error?.may_have_mutated === false,
  );
  assert.deepEqual(events, ['BEGIN', 'INSERT lease', 'ROLLBACK', 'RELEASE']);
});

test('Cloud Run Postgres binding marks connection acquisition failure as non-mutating', async () => {
  const expected = Object.assign(new Error('database connection unavailable'), { code:'08006' });
  const pool = {
    async query() { return { rows:[] }; },
    async connect() { throw expected; },
  };
  const db = createCloudRunDatabaseBinding(pool);
  await assert.rejects(
    db.transaction([{ sql:'INSERT lease', params:[] }]),
    error => error === expected && error?.may_have_mutated === false,
  );
});

test('Cloud Run Postgres binding marks failed COMMIT as mutation-ambiguous', async () => {
  const events = [];
  const expected = Object.assign(new Error('database connection lost while committing'), { code:'08006' });
  const pool = {
    async query() { return { rows:[] }; },
    async connect() {
      return {
        async query(sql) {
          events.push(sql);
          if (sql === 'COMMIT') throw expected;
          return { rows:[] };
        },
        release() { events.push('RELEASE'); },
      };
    },
  };
  const db = createCloudRunDatabaseBinding(pool);
  await assert.rejects(
    db.transaction([{ sql:'INSERT lease', params:[] }]),
    error => error === expected && error?.may_have_mutated === true,
  );
  assert.deepEqual(events, ['BEGIN', 'INSERT lease', 'COMMIT', 'ROLLBACK', 'RELEASE']);
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
    authority_mode: 'shadow',
  });
});

test('shadow mode exposes read-only project inspection without enabling semantic writes', async () => {
  let inspections = 0;
  const handler = createCloudRunHandler({
    db: { query: async () => ({ rows: [] }) },
    runtime: { publishAndVerify: async () => { throw new Error('not called'); } },
    projectInspect: async input => { inspections += 1; return { project_ref:input.project_ref, complete:false }; },
    authorityMode: 'shadow',
  });
  const response = responseRecorder();
  await handler(await request({
    method:'POST',
    url:'/api/authoritative-state/project-inspect',
    body:JSON.stringify({ project_ref:'github:owner/repo' }),
  }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(inspections, 1);
  assert.deepEqual(JSON.parse(response.body), {
    ok:true,
    authority_mode:'shadow',
    inspection:{ project_ref:'github:owner/repo', complete:false },
  });
});

test('private runtime exposes read-only authority proof inspection without invoking semantic writes', async () => {
  let proofCalls = 0;
  let workerCalls = 0;
  const handler = createCloudRunHandler({
    db: { query: async () => ({ rows: [] }) },
    runtime: { publishAndVerify: async () => { throw new Error('not called'); } },
    authorityProofInspect: async input => {
      proofCalls += 1;
      return { schema:'overcenter-authority-proof-inspect-v1', phase:input.phase, counts:{ runs:1 } };
    },
    workerCommand: async () => { workerCalls += 1; return { status:200, body:{ ok:true } }; },
    authorityMode:'authoritative',
  });
  const response = responseRecorder();
  await handler(await request({
    method:'POST',
    url:'/api/authoritative-state/proof-inspect',
    body:JSON.stringify({ phase:'failed-attempt', project_ref:'github:owner/repo' }),
  }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(proofCalls, 1);
  assert.equal(workerCalls, 0);
  assert.deepEqual(JSON.parse(response.body), {
    ok:true,
    authority_mode:'authoritative',
    proof:{ schema:'overcenter-authority-proof-inspect-v1', phase:'failed-attempt', counts:{ runs:1 } },
  });
});

test('shadow mode rejects semantic worker commands before invocation', async () => {
  let calls = 0;
  const handler = createCloudRunHandler({
    db: { query: async () => ({ rows: [] }) },
    runtime: { publishAndVerify: async () => { throw new Error('not called'); } },
    workerCommand: async () => { calls += 1; return { status:200, body:{ ok:true } }; },
    authorityMode: 'shadow',
  });
  const response = responseRecorder();
  await handler(await request({ method:'POST', url:'/api/worker-command', body:JSON.stringify({ command:'project.advance', input:{} }) }), response);
  assert.equal(response.statusCode, 409);
  assert.equal(calls, 0);
  assert.deepEqual(JSON.parse(response.body), {
    ok:false,
    error:'AUTHORITY_WRITES_DISABLED',
    authority_mode:'shadow',
    may_have_mutated:false,
  });
});

test('authoritative mode permits semantic worker commands', async () => {
  let calls = 0;
  const handler = createCloudRunHandler({
    db: { query: async () => ({ rows: [] }) },
    runtime: { publishAndVerify: async () => { throw new Error('not called'); } },
    workerCommand: async () => { calls += 1; return { status:200, body:{ ok:true, command:'project.inspect' } }; },
    authorityMode: 'authoritative',
  });
  const response = responseRecorder();
  await handler(await request({ method:'POST', url:'/api/worker-command', body:JSON.stringify({ command:'project.inspect', input:{} }) }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(calls, 1);
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
