import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSemanticCommandReceipt,
  createPostgresSemanticCommandReceiptStore,
  sanitizeSemanticCommandResponse,
  verifySemanticCommandReceipt,
} from '../lib/semantic-command-receipts.js';

const SOURCE = 'a'.repeat(40);
const REQUEST_ID = 'receipt-test-1';

function memoryDb() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO semantic_command_receipts')) {
        const [requestId, receiptRef, command, sourceRevision, requestSha, responseSha, receiptSha, receiptJson] = params;
        if (rows.has(requestId)) return { rows:[] };
        const receipt = JSON.parse(receiptJson);
        rows.set(requestId, {
          request_id:requestId,
          receipt_ref:receiptRef,
          command,
          source_revision:sourceRevision,
          request_sha256:requestSha,
          response_sha256:responseSha,
          receipt_sha256:receiptSha,
          receipt,
        });
        return { rows:[rows.get(requestId)] };
      }
      if (sql.includes('WHERE request_id = $1')) {
        const row = rows.get(params[0]);
        return { rows:row ? [row] : [] };
      }
      if (sql.includes('WHERE receipt_ref = $1')) {
        const row = [...rows.values()].find(value => value.receipt_ref === params[0]);
        return { rows:row ? [row] : [] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

test('semantic command receipt sanitizes secrets and binds canonical response bytes', async () => {
  const receipt = await buildSemanticCommandReceipt({
    request_id:REQUEST_ID,
    command:'project.amend',
    source_revision:SOURCE,
    request:{ command:'project.amend', input:{ project_ref:'github:owner/repo' } },
    response:{ ok:true, token:'secret', nested:{ lease_token:'secret', value:2 } },
    http_status:200,
    created_at:'2026-09-15T14:00:00.000Z',
  });
  assert.deepEqual(receipt.response, { ok:true, nested:{ value:2 } });
  assert.match(receipt.request_sha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.response_sha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.receipt_sha256, /^[0-9a-f]{64}$/);
  assert.equal(receipt.receipt_ref, `semantic-command-receipt:${REQUEST_ID}`);
  assert.deepEqual(await verifySemanticCommandReceipt(receipt), receipt);
});

test('semantic command response sanitizer is recursive and non-mutating', () => {
  const input = { token:'x', keep:1, array:[{ authorization:'y', keep:2 }] };
  assert.deepEqual(sanitizeSemanticCommandResponse(input), { keep:1, array:[{ keep:2 }] });
  assert.equal(input.token, 'x');
});

test('receipt store replays an exact request without replacing authoritative evidence', async () => {
  const db = memoryDb();
  const store = createPostgresSemanticCommandReceiptStore(db, { now:() => '2026-09-15T14:00:00.000Z' });
  const request = { command:'project.inspect', input:{ project_ref:'github:owner/repo' } };
  const first = await store.record({
    request_id:REQUEST_ID,
    command:'project.inspect',
    source_revision:SOURCE,
    request,
    response:{ ok:true, value:1 },
    http_status:200,
  });
  const replay = await store.replay({ request_id:REQUEST_ID, command:'project.inspect', source_revision:SOURCE, request });
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.receipt.receipt_sha256, first.receipt.receipt_sha256);
  assert.deepEqual(replay.receipt.response, { ok:true, value:1 });
});

test('receipt store rejects request identity reuse with a different request digest', async () => {
  const db = memoryDb();
  const store = createPostgresSemanticCommandReceiptStore(db, { now:() => '2026-09-15T14:00:00.000Z' });
  await store.record({
    request_id:REQUEST_ID,
    command:'project.inspect',
    source_revision:SOURCE,
    request:{ command:'project.inspect', input:{ project_ref:'github:owner/repo' } },
    response:{ ok:true },
    http_status:200,
  });
  await assert.rejects(
    store.replay({
      request_id:REQUEST_ID,
      command:'project.inspect',
      source_revision:SOURCE,
      request:{ command:'project.inspect', input:{ project_ref:'github:other/repo' } },
    }),
    error => error?.code === 'SEMANTIC_RECEIPT_IDENTITY_CONFLICT' && error?.may_have_mutated === false,
  );
});

test('receipt retrieval verifies the caller digest and fails closed on stored tampering', async () => {
  const db = memoryDb();
  const store = createPostgresSemanticCommandReceiptStore(db, { now:() => '2026-09-15T14:00:00.000Z' });
  const recorded = await store.record({
    request_id:REQUEST_ID,
    command:'project.inspect',
    source_revision:SOURCE,
    request:{ command:'project.inspect', input:{} },
    response:{ ok:true },
    http_status:200,
  });
  const read = await store.read({ receipt_ref:recorded.receipt.receipt_ref, expected_receipt_sha256:recorded.receipt.receipt_sha256 });
  assert.deepEqual(read, recorded.receipt);

  db.rows.get(REQUEST_ID).receipt.response.ok = false;
  await assert.rejects(
    store.read({ receipt_ref:recorded.receipt.receipt_ref }),
    error => error?.code === 'SEMANTIC_RECEIPT_DIGEST_MISMATCH' && error?.may_have_mutated === false,
  );
});
