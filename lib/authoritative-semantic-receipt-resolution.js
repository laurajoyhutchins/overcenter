import { verifySemanticCommandReceipt } from './semantic-command-receipts.js';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,512}$/;
const COMMAND = /^[a-z0-9_.-]{1,128}$/;
const RECEIPT_REF = /^semantic-command-receipt:[A-Za-z0-9._:-]{1,512}$/;
const POINTER_SCHEMA = 'semantic-command-receipt-pointer-v1';

function fail(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    httpStatus:409,
    may_have_mutated:true,
    details,
  });
}

function pointerFrom(response) {
  return response && typeof response === 'object' && !Array.isArray(response)
    ? response.authority_receipt
    : null;
}

function semanticResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return response;
  const { authority_receipt: _pointer, ...body } = response;
  return body;
}

function validatePointer(pointer, expected) {
  if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)
      || pointer.schema !== POINTER_SCHEMA
      || !RECEIPT_REF.test(String(pointer.receipt_ref || ''))
      || !SHA256.test(String(pointer.receipt_sha256 || '').toLowerCase())
      || !SHA256.test(String(pointer.response_sha256 || '').toLowerCase())
      || !REQUEST_ID.test(String(pointer.request_id || ''))
      || !COMMAND.test(String(pointer.command || ''))
      || !SHA40.test(String(pointer.source_revision || '').toLowerCase())) {
    throw fail('AUTHORITATIVE_SEMANTIC_RECEIPT_POINTER_INVALID', 'semantic workflow response carries an invalid authoritative receipt pointer');
  }
  if (pointer.request_id !== expected.request_id
      || pointer.command !== expected.command
      || String(pointer.source_revision).toLowerCase() !== expected.expected_head) {
    throw fail('AUTHORITATIVE_SEMANTIC_RECEIPT_POINTER_IDENTITY_MISMATCH', 'authoritative semantic receipt pointer does not match invocation identity', {
      request_id:expected.request_id,
      command:expected.command,
      expected_head:expected.expected_head,
    });
  }
  return Object.freeze({
    schema:POINTER_SCHEMA,
    receipt_ref:pointer.receipt_ref,
    receipt_sha256:String(pointer.receipt_sha256).toLowerCase(),
    response_sha256:String(pointer.response_sha256).toLowerCase(),
    request_id:pointer.request_id,
    command:pointer.command,
    source_revision:String(pointer.source_revision).toLowerCase(),
  });
}

export async function resolveAuthoritativeSemanticReceipt(terminal, expected, options = {}) {
  const response = terminal?.response;
  const rawPointer = pointerFrom(response);
  if (!rawPointer) return terminal;
  const identity = {
    request_id:String(expected?.request_id || ''),
    command:String(expected?.command || ''),
    expected_head:String(expected?.expected_head || '').toLowerCase(),
  };
  const pointer = validatePointer(rawPointer, identity);
  const fallback = Object.freeze({
    ...terminal,
    response:semanticResponse(response),
    receipt:Object.freeze({
      ...(terminal?.receipt || {}),
      authority_receipt:pointer,
      authority_receipt_verified:false,
    }),
  });
  const readReceipt = options.readAuthoritativeSemanticReceipt;
  if (typeof readReceipt !== 'function') return fallback;

  const observed = await readReceipt({
    receipt_ref:pointer.receipt_ref,
    expected_receipt_sha256:pointer.receipt_sha256,
  });
  const authoritative = await verifySemanticCommandReceipt(observed?.receipt || observed, pointer.receipt_sha256);
  if (authoritative.request_id !== identity.request_id
      || authoritative.command !== identity.command
      || authoritative.source_revision !== identity.expected_head
      || authoritative.response_sha256 !== pointer.response_sha256) {
    throw fail('AUTHORITATIVE_SEMANTIC_RECEIPT_IDENTITY_MISMATCH', 'retrieved authoritative semantic receipt does not match invocation identity', {
      receipt_ref:pointer.receipt_ref,
    });
  }
  return Object.freeze({
    ...terminal,
    response:authoritative.response,
    receipt:Object.freeze({
      ...(terminal?.receipt || {}),
      authority_receipt:pointer,
      authority_receipt_verified:true,
    }),
  });
}
