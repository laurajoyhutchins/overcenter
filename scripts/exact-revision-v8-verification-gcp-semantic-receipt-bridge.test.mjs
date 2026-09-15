import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/gcp-semantic-command.yml', import.meta.url), 'utf8');
const cloudRun = await readFile(new URL('./cloud-run.mjs', import.meta.url), 'utf8');
const host = await readFile(new URL('./cloud-run-host.mjs', import.meta.url), 'utf8');
const ingress = await readFile(new URL('../lib/authoritative-semantic-command-ingress.js', import.meta.url), 'utf8');
const resolver = await readFile(new URL('../lib/authoritative-semantic-receipt-resolution.js', import.meta.url), 'utf8');

test('authoritative Cloud Run composition persists semantic receipts against deployed source revision', () => {
  assert.match(cloudRun, /createPostgresSemanticCommandReceiptStore/);
  assert.match(cloudRun, /semanticReceiptStore/);
  assert.match(cloudRun, /sourceRevision:process\.env\.OVERCENTER_SOURCE_REVISION/);
  assert.match(host, /SEMANTIC_RECEIPT_SOURCE_REVISION_MISMATCH/);
  assert.match(host, /x-overcenter-expected-head/);
  assert.match(host, /semanticCommandReceiptPointer/);
});

test('semantic workflow proves GCP receipt retrieval before retaining transitional artifact fallback', () => {
  assert.match(workflow, /x-overcenter-expected-head: \$EXPECTED_HEAD/);
  assert.match(workflow, /api\/authoritative-state\/semantic-receipt/);
  assert.match(workflow, /semantic-command-receipt-pointer-v1/);
  assert.match(workflow, /expected_receipt_sha256/);
  assert.match(workflow, /cmp "\$RUNNER_TEMP\/semantic-response-body\.json" "\$RUNNER_TEMP\/semantic-receipt-body\.json"/);
  assert.match(workflow, /authority_receipt:\$response\[0\]\.authority_receipt/);
  assert.match(workflow, /response_b64/);
  assert.match(workflow, /retention-days: 30/);
});

test('authoritative ingress can prefer GCP receipt while historical GitHub artifacts remain readable', () => {
  assert.match(ingress, /resolveAuthoritativeSemanticReceipt/);
  assert.match(ingress, /readAuthoritativeSemanticReceipt:options\.readAuthoritativeSemanticReceipt/);
  assert.match(resolver, /if \(!rawPointer\) return terminal/);
  assert.match(resolver, /authority_receipt_verified:false/);
  assert.match(resolver, /authority_receipt_verified:true/);
  assert.match(resolver, /verifySemanticCommandReceipt/);
});
