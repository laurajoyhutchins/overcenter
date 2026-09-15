import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticCommandReceipt, semanticCommandReceiptPointer } from '../lib/semantic-command-receipts.js';
import { resolveAuthoritativeSemanticReceipt } from '../lib/authoritative-semantic-receipt-resolution.js';

const SOURCE='a'.repeat(40);
const REQUEST_ID='resolve-1';
const COMMAND='project.amend';
const expected={request_id:REQUEST_ID,command:COMMAND,expected_head:SOURCE};

async function receipt(response={ok:true,value:'gcp'}) {
  return buildSemanticCommandReceipt({request_id:REQUEST_ID,command:COMMAND,source_revision:SOURCE,request:{command:COMMAND,input:{}},response,http_status:200,created_at:'2026-09-15T14:00:00.000Z'});
}

test('historical artifact response without a GCP pointer remains readable', async()=>{
  const terminal={response:{ok:true,value:'artifact'},receipt:{artifact_id:1}};
  assert.equal(await resolveAuthoritativeSemanticReceipt(terminal,expected),terminal);
});

test('pointer-bearing artifact remains a transitional fallback when no GCP reader is available',async()=>{
  const authoritative=await receipt();
  const terminal={response:{ok:true,value:'artifact',authority_receipt:semanticCommandReceiptPointer(authoritative)},receipt:{artifact_id:1}};
  const resolved=await resolveAuthoritativeSemanticReceipt(terminal,expected);
  assert.deepEqual(resolved.response,{ok:true,value:'artifact'});
  assert.equal(resolved.receipt.authority_receipt_verified,false);
});

test('direct GCP receipt replaces artifact response when a reader is available',async()=>{
  const authoritative=await receipt({ok:true,value:'gcp'});
  const terminal={response:{ok:true,value:'artifact',authority_receipt:semanticCommandReceiptPointer(authoritative)},receipt:{artifact_id:1}};
  const resolved=await resolveAuthoritativeSemanticReceipt(terminal,expected,{readAuthoritativeSemanticReceipt:async()=>({receipt:authoritative})});
  assert.deepEqual(resolved.response,{ok:true,value:'gcp'});
  assert.equal(resolved.receipt.authority_receipt_verified,true);
  assert.equal(resolved.receipt.authority_receipt.receipt_sha256,authoritative.receipt_sha256);
});

test('retrieved receipt identity mismatch fails closed instead of falling back',async()=>{
  const authoritative=await receipt();
  const wrong=await buildSemanticCommandReceipt({request_id:'resolve-other',command:COMMAND,source_revision:SOURCE,request:{},response:{ok:true},http_status:200,created_at:'2026-09-15T14:00:00.000Z'});
  const terminal={response:{ok:true,value:'artifact',authority_receipt:semanticCommandReceiptPointer(authoritative)},receipt:{artifact_id:1}};
  await assert.rejects(resolveAuthoritativeSemanticReceipt(terminal,expected,{readAuthoritativeSemanticReceipt:async()=>wrong}), error => ['SEMANTIC_RECEIPT_DIGEST_MISMATCH','AUTHORITATIVE_SEMANTIC_RECEIPT_IDENTITY_MISMATCH'].includes(error?.code));
});
