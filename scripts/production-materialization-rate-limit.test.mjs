import assert from 'node:assert/strict';
import test from 'node:test';

const revision = 'a'.repeat(40);

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

test('production materialization CLI enables pacing for the live Hatchable transport', async () => {
  const { PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS } = await import('./production-materialization-http.mjs');
  assert.equal(PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS, 1100);
});
