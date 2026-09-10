import assert from 'node:assert/strict';
import test from 'node:test';

const revision = 'a'.repeat(40);
const repository = 'laurajoyhutchins/overcenter';

test('production runtime adapter paces remote calls so large stale projections do not burst the Hatchable MCP transport', async () => {
  const { createProductionRuntimeAdapter } = await import('./production-materialization-http.mjs');
  const calls = [];
  const waits = [];
  const runtime = createProductionRuntimeAdapter({
    minimumCallIntervalMs: 1000,
    wait: async milliseconds => waits.push(milliseconds),
    callTool: async (name, args) => {
      calls.push([name, args]);
      if (name === 'get_project') return { current_version: 17 };
      if (name === 'delete_file') return { ok: true };
      if (name === 'write_files') return { ok: true };
      throw new Error(`unexpected tool call: ${name}`);
    },
  });

  await runtime.stage({
    project: 'prod',
    revision,
    expected_version: 17,
    writes: [{ path: 'api/gcp-semantic-command-dispatch.js', content: 'exact' }],
    deletes: ['lib/stale-a.js', 'lib/stale-b.js', 'lib/stale-c.js'],
  });

  assert.deepEqual(calls.map(([name]) => name), [
    'get_project',
    'delete_file',
    'delete_file',
    'delete_file',
    'write_files',
  ]);
  assert.deepEqual(waits, [1000, 1000, 1000, 1000]);
});

test('production materialization rotates Hatchable MCP connections before the remote attempt budget is exhausted', async () => {
  const { createRotatingHatchableCallTool } = await import('./production-materialization-http.mjs');
  const connections = [];
  const transport = createRotatingHatchableCallTool({
    maxCallsPerConnection: 3,
    connect: async () => {
      const id = connections.length + 1;
      const record = { id, calls: [], closed: 0 };
      connections.push(record);
      return {
        callTool: async (name, args) => {
          record.calls.push([name, args]);
          return { connection: id, name };
        },
        close: async () => { record.closed += 1; },
      };
    },
  });

  const results = [];
  for (let index = 0; index < 5; index += 1) {
    results.push(await transport.callTool(`tool-${index + 1}`, { index }));
  }
  await transport.close();

  assert.deepEqual(results.map(result => result.connection), [1, 1, 1, 2, 2]);
  assert.deepEqual(connections.map(connection => connection.calls.map(([name]) => name)), [
    ['tool-1', 'tool-2', 'tool-3'],
    ['tool-4', 'tool-5'],
  ]);
  assert.deepEqual(connections.map(connection => connection.closed), [1, 1]);
});

test('connection rotation never replays a failed remote call', async () => {
  const { createRotatingHatchableCallTool } = await import('./production-materialization-http.mjs');
  const connections = [];
  const transport = createRotatingHatchableCallTool({
    maxCallsPerConnection: 3,
    connect: async () => {
      const id = connections.length + 1;
      const record = { id, calls: [], closed: 0 };
      connections.push(record);
      return {
        callTool: async (name, args) => {
          record.calls.push([name, args]);
          throw Object.assign(new Error('transport lost after dispatch'), { may_have_mutated: true });
        },
        close: async () => { record.closed += 1; },
      };
    },
  });

  await assert.rejects(
    transport.callTool('delete_file', { project_id: 'prod', path: 'lib/stale.js' }),
    error => error?.message === 'transport lost after dispatch' && error?.may_have_mutated === true,
  );
  assert.equal(connections.length, 1);
  assert.deepEqual(connections[0].calls, [['delete_file', { project_id: 'prod', path: 'lib/stale.js' }]]);
  await transport.close();
  assert.equal(connections[0].closed, 1);
});

test('production materialization CLI enables pacing for the live Hatchable transport', async () => {
  const { PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS } = await import('./production-materialization-http.mjs');
  assert.equal(PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS, 1100);
});

test('production verification proves the thin GCP transport boundary after deployment instead of requiring a retired Hatchable regression endpoint', async () => {
  const { createProductionRuntimeAdapter } = await import('./production-materialization-http.mjs');
  const calls = [];
  const runtime = createProductionRuntimeAdapter({
    callTool: async (name, args) => {
      calls.push([name, args]);
      if (name === 'run_function' && args.path === '/api/gcp-semantic-command-dispatch') {
        return {
          status: 422,
          body: {
            ok: false,
            error: 'GCP_SEMANTIC_DISPATCH_INVALID',
            message: 'expected_head must be an exact 40-character Git SHA',
            may_have_mutated: false,
          },
        };
      }
      throw new Error(`unexpected tool call: ${name}:${args.path || ''}`);
    },
  });

  const evidence = await runtime.runRegressions({ project: 'prod', repository, revision });

  assert.deepEqual(calls, [[
    'run_function',
    {
      project_id: 'prod',
      path: '/api/gcp-semantic-command-dispatch',
      method: 'POST',
      body: {
        command: 'project.inspect',
        project_ref: `github:${repository}`,
        expected_head: 'not-a-sha',
      },
    },
  ]]);
  assert.deepEqual(evidence, {
    ok: true,
    schema: 'regression-verification-v1',
    passed: 1,
    failed: 0,
    boundary: 'hatchable_to_gcp',
    validation: 'exact_head_fail_closed',
  });
});
