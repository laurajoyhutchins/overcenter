import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const revision = 'a'.repeat(40);
const repository = 'laurajoyhutchins/overcenter';
const SHARED_HATCHABLE_MCP_GROUP = 'overcenter-hatchable-mcp';

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

test('Hatchable MCP workflows share one non-cancelling account-rate concurrency lane', () => {
  const exactRevision = readFileSync(new URL('../.github/workflows/exact-revision-v8.yml', import.meta.url), 'utf8');
  const productionMaterialization = readFileSync(new URL('../.github/workflows/production-materialization.yml', import.meta.url), 'utf8');
  const group = source => source.match(/concurrency:\s*\n\s*group:\s*([^\n]+)/)?.[1]?.trim();

  assert.equal(group(exactRevision), SHARED_HATCHABLE_MCP_GROUP);
  assert.equal(group(productionMaterialization), SHARED_HATCHABLE_MCP_GROUP);
  assert.match(exactRevision, /concurrency:\s*\n\s*group:\s*overcenter-hatchable-mcp\s*\n\s*cancel-in-progress:\s*false/);
  assert.match(productionMaterialization, /concurrency:\s*\n\s*group:\s*overcenter-hatchable-mcp\s*\n\s*cancel-in-progress:\s*false/);
});

test('production materialization dist CLI wires pacing into the live Hatchable transport', async () => {
  const { PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS } = await import('./production-materialization-http.mjs');
  assert.equal(PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS, 1100);

  const distDriver = readFileSync(new URL('./production-materialization-dist-http.mjs', import.meta.url), 'utf8');
  assert.match(distDriver, /PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS/);
  assert.match(
    distDriver,
    /createProductionRuntimeAdapter\(\{\s*callTool:\s*connection\.callTool,\s*minimumCallIntervalMs:\s*PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS,?\s*\}\)/s,
  );
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
