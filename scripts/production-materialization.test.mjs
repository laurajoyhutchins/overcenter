import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const revision = 'a'.repeat(40);
const repository = 'laurajoyhutchins/overcenter';
const receiptPath = 'public/.overcenter/source-materialization.json';

function identity(path, content) {
  return {
    path,
    hash:createHash('sha256').update(content).digest('hex'),
    size:Buffer.byteLength(content),
  };
}

test('materializes the exact production revision through one manifest reconciliation request', async () => {
  const { materializeProductionRevision } = await import('./production-materialization.mjs');
  let reconcileRequest = null;
  const sourceContent = 'export const value=1;';
  const sourceFile = identity('api/gcp-semantic-command-dispatch.js', sourceContent);
  const regression = { ok:true, schema:'regression-verification-v1', passed:700, failed:0 };

  const result = await materializeProductionRevision(
    { repository, revision, branch:'main', production_project:'production-slot' },
    {
      source:{ observe:async () => ({ repository, revision, files:[{ path:sourceFile.path, content:`${sourceContent}\n` }] }) },
      runtime:{
        inspect:async () => ({ project:'production-slot', version:12, files:[identity('api/stale.js', 'stale')] }),
        reconcileManifest:async request => {
          reconcileRequest = request;
          const receiptWrite = request.writes.find(file => file.path === receiptPath);
          return {
            ok:true,
            schema:'manifest-reconciliation-receipt-v1',
            project:'production-slot',
            expected_version:12,
            deployment_version:13,
            manifest_sha256:request.manifest_sha256,
            reconciliation_sha256:request.reconciliation_sha256,
            provider_receipt_sha256:createHash('sha256').update(receiptWrite.content).digest('hex'),
            immutable_files:[sourceFile, identity(receiptPath, receiptWrite.content)],
          };
        },
        runRegressions:async () => regression,
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.schema, 'production-materialization-v2');
  assert.equal(result.deployment_version, 13);
  assert.equal(result.regression.failed, 0);
  assert.deepEqual(reconcileRequest.deletes, ['api/stale.js']);
  assert.equal(reconcileRequest.expected_version, 12);
  assert.equal(reconcileRequest.target_version, 13);
  assert.match(reconcileRequest.reconciliation_sha256, /^[0-9a-f]{64}$/);
  const receipt = JSON.parse(reconcileRequest.writes.find(file => file.path === receiptPath).content);
  assert.equal(receipt.schema, 'source-materialization-receipt-v2');
  assert.equal(receipt.github_head, revision);
  assert.equal(receipt.base_hatchable_version, 12);
  assert.equal(receipt.target_hatchable_version, 13);
  assert.equal(receipt.reconciliation_sha256, reconcileRequest.reconciliation_sha256);
});

test('production branch updates are serialized into the dist-aware production materialization driver', () => {
  const workflowUrl = new URL('../.github/workflows/production-materialization.yml', import.meta.url);
  assert.equal(existsSync(workflowUrl), true, 'production materialization workflow is missing');
  const workflow = readFileSync(workflowUrl, 'utf8');
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /group:\s*overcenter-hatchable-mcp/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  const build = workflow.indexOf('npm run build:runtime');
  const materialize = workflow.indexOf('node scripts/production-materialization-dist-http.mjs');
  assert.ok(build >= 0);
  assert.ok(materialize >= 0);
  assert.ok(build < materialize);
});

test('remote production adapter reuses immutable replay evidence within one run', async () => {
  const { createProductionRuntimeAdapter } = await import('./production-materialization-http.mjs');
  const { productionRuntimeSourceManifest } = await import('../lib/production-materialization-operation.js');
  const sourceContent = 'export const exact=true;';
  const sourceEntry = identity('api/gcp-semantic-command-dispatch.js', sourceContent);
  const sourceManifest = await productionRuntimeSourceManifest([sourceEntry]);
  const receipt = {
    schema:'source-materialization-receipt-v2',
    authority:'github',
    direction:'github_to_runtime',
    hatchable_project:'prod',
    github_repository:repository,
    github_branch:'main',
    github_head:revision,
    base_hatchable_version:8,
    target_hatchable_version:9,
    target_manifest_sha256:sourceManifest.sha256,
    reconciliation_sha256:'b'.repeat(64),
    source_path_count:sourceManifest.path_count,
  };
  const receiptContent = JSON.stringify(receipt);
  const calls = [];
  const runtime = createProductionRuntimeAdapter({
    callTool:async name => {
      calls.push(name);
      if (name === 'read_file') return { content:receiptContent };
      if (name === 'get_deployment') return { version:9, file_manifest:[sourceEntry, identity(receiptPath, receiptContent)] };
      throw new Error(`unexpected tool call: ${name}`);
    },
  });
  const request = { project:'prod', repository, branch:'main', revision, version:9, source_manifest_sha256:sourceManifest.sha256 };
  const first = await runtime.resolveEvidence(request);
  const second = await runtime.resolveEvidence(request);
  assert.equal(first, second);
  assert.equal(first.verified_revision, revision);
  assert.deepEqual(calls, ['read_file', 'get_deployment']);
});

test('rejects a non-production branch before source access', async () => {
  const { materializeProductionRevision } = await import('./production-materialization.mjs');
  let touched = false;
  await assert.rejects(
    materializeProductionRevision(
      { repository, revision, branch:'dev', production_project:'production-slot' },
      { source:{ observe:async () => { touched = true; return {}; } }, runtime:{} },
    ),
    error => error?.code === 'INVALID_PRODUCTION_BRANCH',
  );
  assert.equal(touched, false);
});

test('rejects immutable reconciliation drift before production regression certification', async () => {
  const { materializeProductionRevision } = await import('./production-materialization.mjs');
  let regressionsRan = false;
  await assert.rejects(
    materializeProductionRevision(
      { repository, revision, branch:'main', production_project:'production-slot' },
      {
        source:{ observe:async () => ({ repository, revision, files:[{ path:'api/gcp-semantic-command-dispatch.js', content:'x\n' }] }) },
        runtime:{
          inspect:async () => ({ project:'production-slot', version:20, files:[] }),
          reconcileManifest:async request => {
            const receiptWrite = request.writes.find(file => file.path === receiptPath);
            return {
              ok:true,
              schema:'manifest-reconciliation-receipt-v1',
              project:'production-slot',
              expected_version:20,
              deployment_version:21,
              manifest_sha256:request.manifest_sha256,
              reconciliation_sha256:request.reconciliation_sha256,
              provider_receipt_sha256:createHash('sha256').update(receiptWrite.content).digest('hex'),
              immutable_files:[
                { path:'api/gcp-semantic-command-dispatch.js', hash:'f'.repeat(64), size:1 },
                identity(receiptPath, receiptWrite.content),
              ],
            };
          },
          runRegressions:async () => { regressionsRan = true; return { ok:true, schema:'regression-verification-v1', failed:0 }; },
        },
      },
    ),
    error => error?.code === 'PRODUCTION_MATERIALIZATION_MISMATCH' && error?.may_have_mutated === true,
  );
  assert.equal(regressionsRan, false);
});

test('typed materialization no-op requires exact verified revision evidence and performs no effect', async () => {
  const { materializeProduction } = await import('../lib/production-materialization-operation.js');
  const content = 'exact-runtime-source';
  const hash = createHash('sha256').update(content).digest('hex');
  let effects = 0;
  const result = await materializeProduction({ repo:repository }, {
    resolveProductionSource:async repo => ({ repository:repo, branch:'main', revision }),
    observeSource:async coordinate => ({ ...coordinate, files:[{ path:'lib/github-workflow-dispatch.js', content }] }),
    observeRuntime:async () => ({
      runtime_ref:'runtime:production',
      version:30,
      files:[{ path:'lib/github-workflow-dispatch.js', hash, size:Buffer.byteLength(content) }],
      verified_revision:revision,
      verification_ref:'immutable:runtime:30',
    }),
    reconcileManifest:async () => { effects += 1; },
    verifyProduction:async () => { throw new Error('verification should not rerun'); },
  });
  assert.equal(result.outcome, 'already_materialized');
  assert.equal(result.deployment_version, 30);
  assert.equal(effects, 0);
});

test('typed materialization rejects stale source authority before any runtime effect', async () => {
  const { materializeProduction } = await import('../lib/production-materialization-operation.js');
  let reconciled = false;
  await assert.rejects(
    materializeProduction({ repo:repository }, {
      resolveProductionSource:async repo => ({ repository:repo, branch:'main', revision }),
      observeSource:async coordinate => ({ ...coordinate, revision:'b'.repeat(40), files:[] }),
      observeRuntime:async () => ({ runtime_ref:'runtime:production', version:1, files:[] }),
      reconcileManifest:async () => { reconciled = true; },
      verifyProduction:async () => ({ ok:true, verification_ref:'unexpected' }),
    }),
    error => error?.code === 'PRODUCTION_MATERIALIZATION_SOURCE_STALE' && error?.may_have_mutated === false,
  );
  assert.equal(reconciled, false);
});

test('typed materialization preserves recovery-required uncertainty from reconciliation', async () => {
  const { materializeProduction } = await import('../lib/production-materialization-operation.js');
  await assert.rejects(
    materializeProduction({ repo:repository }, {
      resolveProductionSource:async repo => ({ repository:repo, branch:'main', revision }),
      observeSource:async coordinate => ({ ...coordinate, files:[{ path:'lib/github-workflow-dispatch.js', content:'new' }] }),
      observeRuntime:async () => ({ runtime_ref:'runtime:production', version:40, files:[] }),
      reconcileManifest:async () => {
        throw Object.assign(new Error('transport disappeared after manifest request'), {
          code:'MANIFEST_RECONCILIATION_INDETERMINATE',
          may_have_mutated:true,
          recovery_required:true,
          automatic_retry:false,
        });
      },
      verifyProduction:async () => ({ ok:true, verification_ref:'unexpected' }),
    }),
    error => error?.code === 'MANIFEST_RECONCILIATION_INDETERMINATE'
      && error?.may_have_mutated === true
      && error?.recovery_required === true
      && error?.automatic_retry === false,
  );
});
