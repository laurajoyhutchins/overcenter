import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const revision = 'a'.repeat(40);
const repository = 'laurajoyhutchins/overcenter';
const SHARED_HATCHABLE_MCP_GROUP = 'overcenter-hatchable-mcp';
const EXACT_REVISION_RUNTIME_GROUP = 'overcenter-exact-revision-runtime';
const receiptPath = 'public/.overcenter/source-materialization.json';
const identity = (path, content) => ({
  path,
  hash:createHash('sha256').update(content).digest('hex'),
  size:Buffer.byteLength(content),
});

test('production runtime adapter reconciles a stale manifest with reduced deterministic call shape and no pacing dependency', async () => {
  const { createProductionRuntimeAdapter } = await import('./production-materialization-http.mjs');
  const calls = [];
  let draftFiles = [identity('api/stale-a.js', 'a'), identity('lib/stale-b.js', 'b')];
  const runtime = createProductionRuntimeAdapter({
    callTool:async (name, args) => {
      calls.push(name);
      if (name === 'get_project') return { current_version:5 };
      if (name === 'list_files') return { files:draftFiles };
      if (name === 'delete_file') {
        draftFiles = draftFiles.filter(file => file.path !== args.path);
        return { ok:true };
      }
      if (name === 'write_files') {
        draftFiles = args.files.map(file => identity(file.path, file.content));
        return { ok:true };
      }
      if (name === 'dry_run_deploy') return { errors:[] };
      if (name === 'deploy') return { ok:true };
      if (name === 'get_deployment') return { version:6, file_manifest:draftFiles };
      throw new Error(`unexpected tool call: ${name}`);
    },
  });

  const initial = await runtime.inspect('prod');
  assert.equal(initial.version, 5);
  const sourceContent = 'new';
  const desired = identity('api/gcp-semantic-command-dispatch.js', sourceContent);
  const receiptContent = '{"schema":"source-materialization-receipt-v2"}';
  const result = await runtime.reconcileManifest({
    project:'prod',
    revision,
    expected_version:5,
    target_version:6,
    manifest_sha256:'c'.repeat(64),
    reconciliation_sha256:'d'.repeat(64),
    desired_files:[desired],
    writes:[
      { path:desired.path, content:sourceContent },
      { path:receiptPath, content:receiptContent },
    ],
    deletes:['api/stale-a.js', 'lib/stale-b.js'],
    receipt_content:receiptContent,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    'get_project', 'list_files',
    'get_project', 'delete_file', 'delete_file', 'write_files',
    'list_files', 'dry_run_deploy', 'deploy', 'get_deployment',
  ]);
  assert.equal(calls.length, 10);
});

test('exact-revision verification is isolated from the Hatchable MCP concurrency lane', () => {
  const exactRevision = readFileSync(new URL('../.github/workflows/exact-revision-v8.yml', import.meta.url), 'utf8');
  const productionMaterialization = readFileSync(new URL('../.github/workflows/production-materialization.yml', import.meta.url), 'utf8');
  const group = source => source.match(/concurrency:\s*\n\s*group:\s*([^\n]+)/)?.[1]?.trim();

  assert.equal(group(exactRevision), EXACT_REVISION_RUNTIME_GROUP);
  assert.equal(group(productionMaterialization), SHARED_HATCHABLE_MCP_GROUP);
  assert.match(exactRevision, /concurrency:\s*\n\s*group:\s*overcenter-exact-revision-runtime\s*\n\s*cancel-in-progress:\s*false/);
  assert.match(productionMaterialization, /concurrency:\s*\n\s*group:\s*overcenter-hatchable-mcp\s*\n\s*cancel-in-progress:\s*false/);
});

test('production materialization source and dist drivers contain no request pacing compatibility path', () => {
  const sourceDriver = readFileSync(new URL('./production-materialization-http.mjs', import.meta.url), 'utf8');
  const distDriver = readFileSync(new URL('./production-materialization-dist-http.mjs', import.meta.url), 'utf8');
  for (const source of [sourceDriver, distDriver]) {
    assert.doesNotMatch(source, /PRODUCTION_HATCHABLE_MINIMUM_CALL_INTERVAL_MS/);
    assert.doesNotMatch(source, /minimumCallIntervalMs/);
    assert.doesNotMatch(source, /pacedCallTool/);
    assert.doesNotMatch(source, /\b1100\b/);
  }
});

test('production verification proves the thin GCP transport boundary after deployment', async () => {
  const { createProductionRuntimeAdapter } = await import('./production-materialization-http.mjs');
  const calls = [];
  const runtime = createProductionRuntimeAdapter({
    callTool:async (name, args) => {
      calls.push([name, args]);
      if (name === 'run_function' && args.path === '/api/gcp-semantic-command-dispatch') {
        return {
          status:422,
          body:{
            ok:false,
            error:'GCP_SEMANTIC_DISPATCH_INVALID',
            message:'expected_head must be an exact 40-character Git SHA',
            may_have_mutated:false,
          },
        };
      }
      throw new Error(`unexpected tool call: ${name}:${args.path || ''}`);
    },
  });

  const evidence = await runtime.runRegressions({ project:'prod', repository, revision });
  assert.equal(evidence.failed, 0);
  assert.deepEqual(calls.map(([name]) => name), ['run_function']);
});
