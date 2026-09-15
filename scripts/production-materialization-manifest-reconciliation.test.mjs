import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileManifest } from '../lib/manifest-reconciliation-operation.js';

const digest = 'a'.repeat(64);
const reconciliation = 'b'.repeat(64);
const receipt = '{"schema":"source-materialization-receipt-v2"}';
const desired = [
  { path:'api/a.js', hash:'1'.repeat(64), size:1 },
  { path:'lib/b.js', hash:'2'.repeat(64), size:1 },
];
const request = {
  project:'prod',
  expected_version:7,
  target_version:8,
  manifest_sha256:digest,
  reconciliation_sha256:reconciliation,
  desired_files:desired,
  writes:[{path:'api/a.js',content:'a'},{path:'lib/b.js',content:'b'}],
  deletes:['api/stale-a.js','lib/stale-b.js'],
  receipt_content:receipt,
};

async function receiptEntry() {
  const bytes = new TextEncoder().encode(receipt);
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
  return { path:'public/.overcenter/source-materialization.json', hash, size:bytes.byteLength };
}
async function immutableFiles() {
  return [...desired, await receiptEntry()];
}

test('exact-version fence succeeds and drift prevents mutation', async () => {
  let effects = 0;
  await assert.rejects(
    reconcileManifest(request, {
      inspectVersion:async () => 9,
      inspectImmutable:async () => ({ version:9, files:[] }),
      deleteFile:async () => { effects += 1; },
      writeFiles:async () => { effects += 1; },
      inspectDraft:async () => ({ version:7, files:[] }),
      dryRun:async () => ({ errors:[] }),
      deploy:async () => {},
    }),
    error => error?.code === 'MANIFEST_RECONCILIATION_VERSION_MISMATCH' && error?.may_have_mutated === false,
  );
  assert.equal(effects, 0);

  const files = await immutableFiles();
  const result = await reconcileManifest(request, {
    inspectVersion:async () => 7,
    deleteFile:async () => {},
    writeFiles:async () => {},
    inspectDraft:async () => ({ version:7, files }),
    dryRun:async () => ({ errors:[] }),
    deploy:async () => {},
    inspectImmutable:async () => ({ version:8, files }),
  });
  assert.equal(result.deployment_version, 8);
});

test('writes and deletes travel through one reconciliation invocation and produce one authoritative receipt', async () => {
  const calls = [];
  const files = await immutableFiles();
  const result = await reconcileManifest(request, {
    inspectVersion:async () => { calls.push('inspectVersion'); return 7; },
    deleteFile:async (_project, path) => calls.push(`delete:${path}`),
    writeFiles:async (_project, writes) => calls.push(`writeFiles:${writes.length}`),
    inspectDraft:async () => { calls.push('inspectDraft'); return { version:7, files }; },
    dryRun:async () => { calls.push('dryRun'); return { errors:[] }; },
    deploy:async () => { calls.push('deploy'); return {}; },
    inspectImmutable:async () => { calls.push('inspectImmutable'); return { version:8, files }; },
  });

  assert.equal(result.schema, 'manifest-reconciliation-receipt-v1');
  assert.equal(result.expected_version, 7);
  assert.equal(result.deployment_version, 8);
  assert.equal(result.manifest_sha256, digest);
  assert.equal(result.reconciliation_sha256, reconciliation);
  assert.equal(result.provider_atomic, false);
  assert.match(result.provider_receipt_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(calls, [
    'inspectVersion',
    'delete:api/stale-a.js',
    'delete:lib/stale-b.js',
    'writeFiles:2',
    'inspectDraft',
    'dryRun',
    'deploy',
    'inspectImmutable',
  ]);
});

test('identical completed replay is idempotent and creates no duplicate effects', async () => {
  const calls = [];
  const files = await immutableFiles();
  const result = await reconcileManifest(request, {
    inspectVersion:async () => { calls.push('inspectVersion'); return 8; },
    inspectImmutable:async () => { calls.push('inspectImmutable'); return { version:8, files }; },
    deleteFile:async () => assert.fail('replay must not delete'),
    writeFiles:async () => assert.fail('replay must not write'),
    inspectDraft:async () => assert.fail('replay must not inspect draft'),
    dryRun:async () => assert.fail('replay must not dry-run'),
    deploy:async () => assert.fail('replay must not deploy'),
  });

  assert.equal(result.idempotent, true);
  assert.equal(result.mutation_attempted, false);
  assert.deepEqual(calls, ['inspectVersion', 'inspectImmutable']);
});

test('uncertain provider outcome enters recovery and is not blindly retried', async () => {
  let deletes = 0;
  await assert.rejects(
    reconcileManifest(request, {
      inspectVersion:async () => 7,
      deleteFile:async () => { deletes += 1; throw new Error('transport vanished'); },
      writeFiles:async () => assert.fail('must not retry or continue'),
      inspectDraft:async () => assert.fail(),
      dryRun:async () => assert.fail(),
      deploy:async () => assert.fail(),
      inspectImmutable:async () => assert.fail(),
    }),
    error => error?.code === 'MANIFEST_RECONCILIATION_INDETERMINATE'
      && error?.may_have_mutated === true
      && error?.recovery_required === true
      && error?.automatic_retry === false,
  );
  assert.equal(deletes, 1);
});
