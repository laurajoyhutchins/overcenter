import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const revision = 'a'.repeat(40);
const repository = 'laurajoyhutchins/overcenter';

function manifestFromWrites(writes) {
  return writes.map(({ path, content }) => ({
    path,
    hash: createHash('sha256').update(content).digest('hex'),
    size: Buffer.byteLength(content),
  })).sort((a, b) => a.path.localeCompare(b.path));
}

test('materializes the exact production revision and proves the immutable deployment', async () => {
  const module = await import('./production-materialization.mjs');
  let staged = null;
  let stageRequest = null;
  const regression = { ok: true, schema: 'regression-verification-v1', passed: 700, failed: 0 };
  const input = { repository, revision, branch: 'main', production_project: 'production-slot' };
  const adapters = {
    source: {
      observe: async () => ({
        repository,
        revision,
        files: [{ path: 'api/example.js', content: 'export const value=1;\n' }],
      }),
    },
    runtime: {
      inspect: async () => ({
        project: 'production-slot',
        version: 12,
        files: [{ path: 'api/stale.js', hash: 'b'.repeat(64), size: 7 }],
      }),
      stage: async request => {
        stageRequest = request;
        staged = manifestFromWrites(request.writes);
      },
      inspectDraft: async () => ({ project: 'production-slot', version: 12, files: staged }),
      deploy: async () => ({ version: 13 }),
      inspectDeployment: async () => ({ version: 13, files: staged }),
      runRegressions: async () => regression,
    },
  };

  const result = await module.materializeProductionRevision?.(input, adapters);

  assert.equal(result?.ok, true);
  assert.equal(result?.schema, 'production-materialization-v1');
  assert.equal(result?.repository, repository);
  assert.equal(result?.revision, revision);
  assert.equal(result?.branch, 'main');
  assert.equal(result?.deployment_version, 13);
  assert.equal(result?.regression.failed, 0);
  assert.deepEqual(stageRequest.deletes, ['api/stale.js']);
  const sourceWrite = stageRequest.writes.find(item => item.path === 'api/example.js');
  assert.equal(sourceWrite.content, 'export const value=1;');
  const receiptWrite = stageRequest.writes.find(item => item.path === 'public/.overcenter/source-materialization.json');
  const receipt = JSON.parse(receiptWrite.content);
  assert.equal(receipt.github_repository, repository);
  assert.equal(receipt.github_branch, 'main');
  assert.equal(receipt.github_head, revision);
  assert.equal(receipt.base_hatchable_version, 12);
  assert.equal(receipt.target_hatchable_version, 13);
  assert.equal(receipt.source_path_count, 1);
});

test('production branch updates are serialized into the production materialization driver', () => {
  const workflowUrl = new URL('../.github/workflows/production-materialization.yml', import.meta.url);
  assert.equal(existsSync(workflowUrl), true, 'production materialization workflow is missing');
  const workflow = readFileSync(workflowUrl, 'utf8');
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /group:\s*overcenter-production-materialization/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /node scripts\/production-materialization-http\.mjs/);
});

test('remote production adapter fences, stages, deploys, and reads immutable file_manifest', async () => {
  const http = await import('./production-materialization-http.mjs');
  const calls = [];
  const responses = [
    { current_version: 5 }, { files: [{ path: 'api/old.js', hash: 'a'.repeat(64), size: 4 }] },
    { current_version: 5 }, { ok: true }, { ok: true },
    { current_version: 5 }, { files: [{ path: 'api/new.js', hash: 'b'.repeat(64), size: 3 }] },
    { current_version: 5 }, { errors: [], would_deploy: {} }, { version: 6 }, { current_version: 6 },
    { version: 6, file_manifest: [{ path: 'api/new.js', hash: 'b'.repeat(64), size: 3 }] },
    { status: 200, body: { ok: true, schema: 'regression-verification-v1', passed: 700, failed: 0 } },
  ];
  const runtime = http.createProductionRuntimeAdapter?.({
    callTool: async (name, args) => {
      calls.push([name, args]);
      return responses.shift();
    },
  });

  assert.deepEqual(await runtime?.inspect('prod'), {
    project: 'prod', version: 5, files: [{ path: 'api/old.js', hash: 'a'.repeat(64), size: 4 }],
  });
  await runtime.stage({
    project: 'prod', revision, expected_version: 5,
    writes: [{ path: 'api/new.js', content: 'new' }], deletes: ['api/old.js'],
  });
  assert.deepEqual(await runtime.inspectDraft('prod'), {
    project: 'prod', version: 5, files: [{ path: 'api/new.js', hash: 'b'.repeat(64), size: 3 }],
  });
  assert.deepEqual(await runtime.deploy({ project: 'prod', revision, expected_version: 5 }), { version: 6 });
  assert.deepEqual(await runtime.inspectDeployment({ project: 'prod', version: 6 }), {
    version: 6, files: [{ path: 'api/new.js', hash: 'b'.repeat(64), size: 3 }],
  });
  assert.equal((await runtime.runRegressions({ project: 'prod' })).failed, 0);
  assert.deepEqual(calls.map(([name]) => name), [
    'get_project', 'list_files',
    'get_project', 'delete_file', 'write_files',
    'get_project', 'list_files',
    'get_project', 'dry_run_deploy', 'deploy', 'get_project',
    'get_deployment', 'run_function',
  ]);
});
