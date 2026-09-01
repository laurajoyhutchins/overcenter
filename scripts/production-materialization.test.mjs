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

test('production branch updates are serialized into the dist-aware production materialization driver', () => {
  const workflowUrl = new URL('../.github/workflows/production-materialization.yml', import.meta.url);
  assert.equal(existsSync(workflowUrl), true, 'production materialization workflow is missing');
  const workflow = readFileSync(workflowUrl, 'utf8');
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /group:\s*overcenter-production-materialization/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  const build = workflow.indexOf('tsc -p tsconfig.semantic.runtime.json');
  const materialize = workflow.indexOf('node scripts/production-materialization-dist-http.mjs');
  assert.ok(build >= 0, 'production materialization must build the runtime artifact');
  assert.ok(materialize >= 0, 'production materialization must use the dist-aware driver');
  assert.ok(build < materialize, 'production materialization must build dist before runtime projection');
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

test('remote production adapter derives verified replay evidence only from the current immutable receipt and source manifest', async () => {
  const http = await import('./production-materialization-http.mjs');
  const { productionRuntimeSourceManifest, SOURCE_MATERIALIZATION_RECEIPT_PATH } = await import('../lib/production-materialization-operation.js');
  const sourceContent = 'export const exact=true;';
  const sourceEntry = {
    path:'api/exact.js',
    hash:createHash('sha256').update(sourceContent).digest('hex'),
    size:Buffer.byteLength(sourceContent),
  };
  const sourceManifest = await productionRuntimeSourceManifest([sourceEntry]);
  const receipt = {
    schema:'source-materialization-receipt-v1',
    authority:'github',
    direction:'github_to_runtime',
    hatchable_project:'prod',
    github_repository:repository,
    github_branch:'main',
    github_head:revision,
    base_hatchable_version:8,
    target_hatchable_version:9,
    target_manifest_sha256:sourceManifest.sha256,
    source_path_count:sourceManifest.path_count,
  };
  const receiptContent = JSON.stringify(receipt);
  const receiptEntry = {
    path:SOURCE_MATERIALIZATION_RECEIPT_PATH,
    hash:createHash('sha256').update(receiptContent).digest('hex'),
    size:Buffer.byteLength(receiptContent),
  };
  const calls = [];
  const runtime = http.createProductionRuntimeAdapter({
    callTool: async (name, args) => {
      calls.push([name, args]);
      if (name === 'get_project') return { current_version:9 };
      if (name === 'list_files') return { files:[sourceEntry] };
      if (name === 'read_file') return { content:receiptContent };
      if (name === 'get_deployment') return { version:9, file_manifest:[sourceEntry, receiptEntry] };
      throw new Error(`unexpected tool call: ${name}`);
    },
  });

  assert.deepEqual(await runtime.inspect('prod', { repository, branch:'main' }), {
    project:'prod',
    version:9,
    files:[sourceEntry],
    verified_revision:revision,
    verification_ref:`immutable-runtime:prod:9:${sourceManifest.sha256}`,
  });
  assert.deepEqual(calls.map(([name]) => name), ['get_project', 'list_files', 'read_file', 'get_deployment']);
});

test('rejects a non-production branch before source access', async () => {
  const { materializeProductionRevision } = await import('./production-materialization.mjs');
  let touched = false;
  await assert.rejects(
    materializeProductionRevision(
      { repository, revision, branch: 'dev', production_project: 'production-slot' },
      { source: { observe: async () => { touched = true; return {}; } }, runtime: {} },
    ),
    error => error?.code === 'INVALID_PRODUCTION_BRANCH',
  );
  assert.equal(touched, false);
});

test('rejects immutable deployment drift before production regression certification', async () => {
  const { materializeProductionRevision } = await import('./production-materialization.mjs');
  let staged = null;
  let regressionsRan = false;
  const adapters = {
    source: {
      observe: async () => ({ repository, revision, files: [{ path: 'api/example.js', content: 'x\n' }] }),
    },
    runtime: {
      inspect: async () => ({ project: 'production-slot', version: 20, files: [] }),
      stage: async request => { staged = manifestFromWrites(request.writes); },
      inspectDraft: async () => ({ project: 'production-slot', version: 20, files: staged }),
      deploy: async () => ({ version: 21 }),
      inspectDeployment: async () => ({
        version: 21,
        files: staged.map(file => file.path === 'api/example.js' ? { ...file, hash: 'f'.repeat(64) } : file),
      }),
      runRegressions: async () => { regressionsRan = true; return { ok: true, schema: 'regression-verification-v1', failed: 0 }; },
    },
  };
  await assert.rejects(
    materializeProductionRevision({ repository, revision, branch: 'main', production_project: 'production-slot' }, adapters),
    error => error?.code === 'PRODUCTION_MATERIALIZATION_MISMATCH' && error?.may_have_mutated === true,
  );
  assert.equal(regressionsRan, false);
});

test('typed materialization no-op requires exact verified revision evidence and performs no effect', async () => {
  const { materializeProduction } = await import('../lib/production-materialization-operation.js');
  const content = 'exact-runtime-source';
  const hash = createHash('sha256').update(content).digest('hex');
  let effects = 0;
  const result = await materializeProduction({ repo: repository }, {
    resolveProductionSource: async repo => ({ repository:repo, branch:'main', revision }),
    observeSource: async coordinate => ({ ...coordinate, files:[{ path:'lib/example.js', content }] }),
    observeRuntime: async () => ({
      runtime_ref:'runtime:production',
      version:30,
      files:[{ path:'lib/example.js', hash, size:Buffer.byteLength(content) }],
      verified_revision:revision,
      verification_ref:'immutable:runtime:30',
    }),
    stageRuntime: async () => { effects += 1; },
    inspectRuntimeDraft: async () => { throw new Error('draft should not be inspected'); },
    deployRuntime: async () => { effects += 1; throw new Error('deploy should not run'); },
    inspectImmutableDeployment: async () => { throw new Error('immutable deployment should not be reread'); },
    verifyProduction: async () => { throw new Error('verification should not rerun'); },
  });

  assert.equal(result.outcome, 'already_materialized');
  assert.equal(result.deployment_version, 30);
  assert.equal(result.verification_ref, 'immutable:runtime:30');
  assert.equal(effects, 0);
});

test('typed materialization rejects stale source authority before any runtime effect', async () => {
  const { materializeProduction } = await import('../lib/production-materialization-operation.js');
  let staged = false;
  await assert.rejects(
    materializeProduction({ repo:repository }, {
      resolveProductionSource: async repo => ({ repository:repo, branch:'main', revision }),
      observeSource: async coordinate => ({ ...coordinate, revision:'b'.repeat(40), files:[] }),
      observeRuntime: async () => ({ runtime_ref:'runtime:production', version:1, files:[] }),
      stageRuntime: async () => { staged = true; },
      inspectRuntimeDraft: async () => ({ runtime_ref:'runtime:production', version:1, files:[] }),
      deployRuntime: async () => ({ runtime_ref:'runtime:production', version:2 }),
      inspectImmutableDeployment: async () => ({ runtime_ref:'runtime:production', version:2, files:[] }),
      verifyProduction: async () => ({ ok:true, verification_ref:'unexpected' }),
    }),
    error => error?.code === 'PRODUCTION_MATERIALIZATION_SOURCE_STALE' && error?.may_have_mutated === false,
  );
  assert.equal(staged, false);
});

test('typed materialization makes mutation certainty monotonic once staging begins', async () => {
  const { materializeProduction } = await import('../lib/production-materialization-operation.js');
  await assert.rejects(
    materializeProduction({ repo:repository }, {
      resolveProductionSource: async repo => ({ repository:repo, branch:'main', revision }),
      observeSource: async coordinate => ({ ...coordinate, files:[{ path:'lib/example.js', content:'new' }] }),
      observeRuntime: async () => ({ runtime_ref:'runtime:production', version:40, files:[] }),
      stageRuntime: async () => { throw new Error('transport disappeared after stage request'); },
      inspectRuntimeDraft: async () => ({ runtime_ref:'runtime:production', version:40, files:[] }),
      deployRuntime: async () => ({ runtime_ref:'runtime:production', version:41 }),
      inspectImmutableDeployment: async () => ({ runtime_ref:'runtime:production', version:41, files:[] }),
      verifyProduction: async () => ({ ok:true, verification_ref:'unexpected' }),
    }),
    error => error?.code === 'PRODUCTION_MATERIALIZATION_INDETERMINATE' && error?.may_have_mutated === true,
  );
});
