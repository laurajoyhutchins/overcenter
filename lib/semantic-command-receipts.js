import { canonicalJson, sha256Text } from './canonical-json.js';

export const SEMANTIC_COMMAND_RECEIPT_SCHEMA = 'semantic-command-receipt-v1';
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,512}$/;
const COMMAND = /^[a-z0-9_.-]{1,128}$/;
const RECEIPT_REF = /^semantic-command-receipt:[A-Za-z0-9._:-]{1,512}$/;
const SECRET_FIELDS = new Set(['lease_token', 'token', 'authorization', 'id_token']);

function receiptError(code, message, details = {}, options = {}) {
  return Object.assign(new Error(message), {
    code,
    httpStatus:options.httpStatus ?? 409,
    may_have_mutated:options.mayHaveMutated === true,
    details,
  });
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function requiredText(value, pattern, field) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!pattern.test(text)) {
    throw receiptError('SEMANTIC_RECEIPT_INVALID', `${field} is invalid`, { field }, { httpStatus:422 });
  }
  return text;
}

function normalizeStatus(value) {
  const status = Number(value);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw receiptError('SEMANTIC_RECEIPT_INVALID', 'http_status must be an HTTP status code', { field:'http_status' }, { httpStatus:422 });
  }
  return status;
}

function normalizeCreatedAt(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !Number.isFinite(Date.parse(text))) {
    throw receiptError('SEMANTIC_RECEIPT_INVALID', 'created_at must be an ISO timestamp', { field:'created_at' }, { httpStatus:422 });
  }
  return new Date(text).toISOString();
}

export function sanitizeSemanticCommandResponse(value) {
  if (Array.isArray(value)) return value.map(sanitizeSemanticCommandResponse);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELDS.has(key.toLowerCase())) continue;
    result[key] = sanitizeSemanticCommandResponse(child);
  }
  return result;
}

export function semanticCommandReceiptPointer(receipt) {
  const value = object(receipt);
  return Object.freeze({
    schema:'semantic-command-receipt-pointer-v1',
    receipt_ref:requiredText(value.receipt_ref, RECEIPT_REF, 'receipt_ref'),
    receipt_sha256:requiredText(String(value.receipt_sha256 || '').toLowerCase(), SHA256, 'receipt_sha256'),
    response_sha256:requiredText(String(value.response_sha256 || '').toLowerCase(), SHA256, 'response_sha256'),
    request_id:requiredText(value.request_id, REQUEST_ID, 'request_id'),
    command:requiredText(value.command, COMMAND, 'command'),
    source_revision:requiredText(String(value.source_revision || '').toLowerCase(), SHA40, 'source_revision'),
  });
}

function receiptDigestPayload(receipt) {
  const copy = { ...receipt };
  delete copy.receipt_sha256;
  return copy;
}

export async function buildSemanticCommandReceipt(input = {}) {
  const requestId = requiredText(input.request_id, REQUEST_ID, 'request_id');
  const command = requiredText(input.command, COMMAND, 'command');
  const sourceRevision = requiredText(String(input.source_revision || '').toLowerCase(), SHA40, 'source_revision');
  const httpStatus = normalizeStatus(input.http_status);
  const createdAt = normalizeCreatedAt(input.created_at);
  const request = object(input.request);
  const response = sanitizeSemanticCommandResponse(object(input.response));
  const requestSha = await sha256Text(canonicalJson(request));
  const responseSha = await sha256Text(canonicalJson(response));
  const receipt = {
    schema:SEMANTIC_COMMAND_RECEIPT_SCHEMA,
    receipt_ref:`semantic-command-receipt:${requestId}`,
    request_id:requestId,
    command,
    source_revision:sourceRevision,
    request_sha256:requestSha,
    response_sha256:responseSha,
    http_status:httpStatus,
    response,
    created_at:createdAt,
  };
  const receiptSha = await sha256Text(canonicalJson(receipt));
  return Object.freeze({ ...receipt, receipt_sha256:receiptSha });
}

export async function verifySemanticCommandReceipt(input, expectedDigest = null) {
  const receipt = object(input);
  if (receipt.schema !== SEMANTIC_COMMAND_RECEIPT_SCHEMA) {
    throw receiptError('SEMANTIC_RECEIPT_INVALID', 'semantic receipt schema is unsupported', { schema:receipt.schema || null });
  }
  requiredText(receipt.receipt_ref, RECEIPT_REF, 'receipt_ref');
  const requestId = requiredText(receipt.request_id, REQUEST_ID, 'request_id');
  if (receipt.receipt_ref !== `semantic-command-receipt:${requestId}`) {
    throw receiptError('SEMANTIC_RECEIPT_IDENTITY_CONFLICT', 'semantic receipt ref does not match request_id');
  }
  requiredText(receipt.command, COMMAND, 'command');
  requiredText(String(receipt.source_revision || '').toLowerCase(), SHA40, 'source_revision');
  requiredText(String(receipt.request_sha256 || '').toLowerCase(), SHA256, 'request_sha256');
  const claimedResponseSha = requiredText(String(receipt.response_sha256 || '').toLowerCase(), SHA256, 'response_sha256');
  const claimedReceiptSha = requiredText(String(receipt.receipt_sha256 || '').toLowerCase(), SHA256, 'receipt_sha256');
  normalizeStatus(receipt.http_status);
  normalizeCreatedAt(receipt.created_at);
  const observedResponseSha = await sha256Text(canonicalJson(object(receipt.response)));
  if (observedResponseSha !== claimedResponseSha) {
    throw receiptError('SEMANTIC_RECEIPT_DIGEST_MISMATCH', 'semantic receipt response digest does not match retained response', {
      expected:claimedResponseSha,
      observed:observedResponseSha,
    });
  }
  const observedReceiptSha = await sha256Text(canonicalJson(receiptDigestPayload(receipt)));
  if (observedReceiptSha !== claimedReceiptSha) {
    throw receiptError('SEMANTIC_RECEIPT_DIGEST_MISMATCH', 'semantic receipt digest does not match retained receipt', {
      expected:claimedReceiptSha,
      observed:observedReceiptSha,
    });
  }
  if (expectedDigest !== null && String(expectedDigest).toLowerCase() !== claimedReceiptSha) {
    throw receiptError('SEMANTIC_RECEIPT_DIGEST_MISMATCH', 'semantic receipt digest does not match caller expectation', {
      expected:String(expectedDigest).toLowerCase(),
      observed:claimedReceiptSha,
    });
  }
  return Object.freeze({ ...receipt, response:sanitizeSemanticCommandResponse(receipt.response) });
}

function rowReceipt(row) {
  if (!row) return null;
  return typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt;
}

function assertIdentity(receipt, expected) {
  if (receipt.command !== expected.command
      || receipt.source_revision !== expected.source_revision
      || receipt.request_sha256 !== expected.request_sha256) {
    throw receiptError('SEMANTIC_RECEIPT_IDENTITY_CONFLICT', 'request_id is already bound to different semantic command evidence', {
      request_id:expected.request_id,
      existing_command:receipt.command,
      existing_source_revision:receipt.source_revision,
    }, { httpStatus:409, mayHaveMutated:false });
  }
}

async function requestIdentity(input) {
  const requestId = requiredText(input.request_id, REQUEST_ID, 'request_id');
  const command = requiredText(input.command, COMMAND, 'command');
  const sourceRevision = requiredText(String(input.source_revision || '').toLowerCase(), SHA40, 'source_revision');
  const request = object(input.request);
  return {
    request_id:requestId,
    command,
    source_revision:sourceRevision,
    request_sha256:await sha256Text(canonicalJson(request)),
  };
}

export function createPostgresSemanticCommandReceiptStore(dbBinding, options = {}) {
  if (!dbBinding || typeof dbBinding.query !== 'function') {
    throw receiptError('SEMANTIC_RECEIPT_RUNTIME_UNAVAILABLE', 'database provider is required', { provider:'db' }, { httpStatus:500 });
  }
  const now = options.now || (() => new Date().toISOString());

  async function byRequestId(requestId) {
    const result = await dbBinding.query(`SELECT request_id, receipt_ref, command, source_revision, request_sha256, response_sha256, receipt_sha256, receipt
      FROM semantic_command_receipts WHERE request_id = $1`, [requestId]);
    return result.rows?.[0] || null;
  }

  async function verifiedRow(row, expectedDigest = null) {
    if (!row) return null;
    const receipt = await verifySemanticCommandReceipt(rowReceipt(row), expectedDigest);
    if (row.receipt_ref !== receipt.receipt_ref
        || row.command !== receipt.command
        || row.source_revision !== receipt.source_revision
        || row.request_sha256 !== receipt.request_sha256
        || row.response_sha256 !== receipt.response_sha256
        || row.receipt_sha256 !== receipt.receipt_sha256) {
      throw receiptError('SEMANTIC_RECEIPT_DIGEST_MISMATCH', 'semantic receipt index columns do not match retained receipt');
    }
    return receipt;
  }

  return Object.freeze({
    async replay(input = {}) {
      const expected = await requestIdentity(input);
      let row;
      try { row = await byRequestId(expected.request_id); }
      catch (error) {
        throw receiptError('SEMANTIC_RECEIPT_READ_FAILED', 'could not inspect authoritative semantic command receipt before execution', {
          cause:String(error?.code || error?.message || error),
        }, { httpStatus:503, mayHaveMutated:false });
      }
      if (!row) return null;
      const receipt = await verifiedRow(row);
      assertIdentity(receipt, expected);
      return Object.freeze({ replayed:true, receipt });
    },

    async record(input = {}) {
      const receipt = await buildSemanticCommandReceipt({ ...input, created_at:input.created_at || now() });
      let result;
      try {
        result = await dbBinding.query(`INSERT INTO semantic_command_receipts (
          request_id, receipt_ref, command, source_revision, request_sha256, response_sha256, receipt_sha256, receipt
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        ON CONFLICT (request_id) DO NOTHING
        RETURNING request_id, receipt_ref, command, source_revision, request_sha256, response_sha256, receipt_sha256, receipt`, [
          receipt.request_id,
          receipt.receipt_ref,
          receipt.command,
          receipt.source_revision,
          receipt.request_sha256,
          receipt.response_sha256,
          receipt.receipt_sha256,
          JSON.stringify(receipt),
        ]);
      } catch (error) {
        throw receiptError('SEMANTIC_RECEIPT_PERSISTENCE_FAILED', 'could not durably persist semantic command receipt', {
          cause:String(error?.code || error?.message || error),
        }, { httpStatus:503, mayHaveMutated:true });
      }
      const inserted = result.rows?.[0];
      if (inserted) return Object.freeze({ replayed:false, receipt:await verifiedRow(inserted) });
      let existing;
      try { existing = await byRequestId(receipt.request_id); }
      catch (error) {
        throw receiptError('SEMANTIC_RECEIPT_PERSISTENCE_FAILED', 'could not confirm semantic command receipt after conflict', {
          cause:String(error?.code || error?.message || error),
        }, { httpStatus:503, mayHaveMutated:true });
      }
      if (!existing) {
        throw receiptError('SEMANTIC_RECEIPT_PERSISTENCE_FAILED', 'semantic command receipt was not durably observable after write', {}, { httpStatus:503, mayHaveMutated:true });
      }
      const existingReceipt = await verifiedRow(existing);
      assertIdentity(existingReceipt, receipt);
      return Object.freeze({ replayed:true, receipt:existingReceipt });
    },

    async read(input = {}) {
      const receiptRef = requiredText(input.receipt_ref, RECEIPT_REF, 'receipt_ref');
      let result;
      try {
        result = await dbBinding.query(`SELECT request_id, receipt_ref, command, source_revision, request_sha256, response_sha256, receipt_sha256, receipt
          FROM semantic_command_receipts WHERE receipt_ref = $1`, [receiptRef]);
      } catch (error) {
        throw receiptError('SEMANTIC_RECEIPT_READ_FAILED', 'could not read authoritative semantic command receipt', {
          cause:String(error?.code || error?.message || error),
        }, { httpStatus:503 });
      }
      const row = result.rows?.[0];
      if (!row) {
        throw receiptError('SEMANTIC_RECEIPT_NOT_FOUND', 'authoritative semantic command receipt was not found', { receipt_ref:receiptRef }, { httpStatus:404 });
      }
      return verifiedRow(row, input.expected_receipt_sha256 || null);
    },
  });
}
