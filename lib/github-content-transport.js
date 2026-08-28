import { canonicalJson } from 'lib/canonical-json.js';
import { selectGithubTextTransport } from 'lib/github-text-transport.js';

const SCHEMA = 'github-content-ref-v1';
const REF = /^gct1_([A-Za-z0-9-]{8,64})$/;
const ID = /^[A-Za-z0-9-]{8,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STORAGE_ROOT = 'tmp/github-content-transport';
const MAX_CONTENT_BYTES = 2_000_000;
const MAX_PAYLOAD_BYTES = 2_000_000;
const MAX_MANIFEST_BYTES = 2_000_000;
const MAX_CHUNKS = 256;
const MAX_CHUNK_BYTES = 256 * 1024;
const EXPIRY_SECONDS = 3600;

export class GitHubContentTransportError extends Error {
  constructor(code, message, details = null, httpStatus = 422) {
    super(message);
    this.name = 'GitHubContentTransportError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = 422) {
  throw new GitHubContentTransportError(code, message, details, httpStatus);
}

function storageApi(storage, operation) {
  if (!storage || typeof storage[operation] !== 'function') {
    fail('CONTENT_REF_STORAGE_UNAVAILABLE', `content-reference storage.${operation} is unavailable`, { operation }, 500);
  }
  return storage;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  fail('CONTENT_REF_INVALID_STORAGE_OBJECT', 'stored content-reference object is not bytes', null, 500);
}

async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function validateText(value, field = 'content') {
  if (typeof value !== 'string') fail('CONTENT_REF_INVALID_UTF8', `${field} must resolve to UTF-8 text`, { field });
  if (value.includes('\u0000')) fail('CONTENT_REF_INVALID_UTF8', `${field} contains NUL`, { field });
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('CONTENT_REF_INVALID_UTF8', `${field} contains an unpaired Unicode surrogate`, { field });
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('CONTENT_REF_INVALID_UTF8', `${field} contains an unpaired Unicode surrogate`, { field });
    }
  }
  return value;
}

function parseReference(contentRef) {
  if (typeof contentRef !== 'string') fail('CONTENT_REF_INVALID', 'content_ref must be an opaque Overcenter content reference');
  const match = REF.exec(contentRef);
  if (!match) fail('CONTENT_REF_INVALID', 'content_ref has an invalid shape');
  return { contentRef, id:match[1] };
}

function prefixFor(id) { return `${STORAGE_ROOT}/${id}`; }
function manifestKeyFor(id) { return `${prefixFor(id)}/manifest.json`; }
function chunkKeyFor(id, index) { return `${prefixFor(id)}/${String(index).padStart(3, '0')}.bin`; }

function nowDate(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('CONTENT_REF_CLOCK_INVALID', 'content-reference clock returned an invalid time', null, 500);
  return date;
}

function exactFields(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CONTENT_REF_INVALID_MANIFEST', `${field} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail('CONTENT_REF_INVALID_MANIFEST', `${field} contains unknown fields`, { field, unknown:unknown.sort() });
}

function integer(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) fail('CONTENT_REF_INVALID_MANIFEST', `${field} is out of range`, { field, value });
  return number;
}

function hexSha(value, field) {
  const normalized = String(value || '').toLowerCase();
  if (!SHA256.test(normalized)) fail('CONTENT_REF_INVALID_MANIFEST', `${field} must be SHA-256`, { field });
  return normalized;
}

function isoTime(value, field) {
  if (typeof value !== 'string') fail('CONTENT_REF_INVALID_MANIFEST', `${field} must be an ISO timestamp`, { field });
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) fail('CONTENT_REF_INVALID_MANIFEST', `${field} must be an ISO timestamp`, { field });
  return time;
}

function validateManifest(raw, expectedId) {
  const common = ['schema','id','created_at','expires_at','mode','content_sha256','content_bytes'];
  exactFields(raw, new Set([
    ...common, 'inline_content', 'inline_gzip_base64', 'payload_sha256', 'payload_bytes', 'stage_encoding', 'chunks',
  ]), 'manifest');
  if (raw.schema !== SCHEMA || raw.id !== expectedId || !ID.test(String(raw.id || ''))) fail('CONTENT_REF_INVALID_MANIFEST', 'content-reference manifest identity does not match its reference');
  if (!['raw-inline','gzip-inline','staged'].includes(raw.mode)) fail('CONTENT_REF_INVALID_MANIFEST', 'content-reference manifest has an invalid mode', { mode:raw.mode });
  const createdAt = isoTime(raw.created_at, 'created_at');
  const expiresAt = isoTime(raw.expires_at, 'expires_at');
  if (expiresAt - createdAt !== EXPIRY_SECONDS * 1000) fail('CONTENT_REF_INVALID_MANIFEST', 'content-reference expiry interval is invalid');
  const observedContentBytes = Number(raw.content_bytes);
  if (Number.isInteger(observedContentBytes) && observedContentBytes > MAX_CONTENT_BYTES) {
    fail('CONTENT_REF_CONTENT_TOO_LARGE', 'content reference exceeds the 2 MB UTF-8 limit', { content_bytes:observedContentBytes });
  }
  const contentBytes = integer(raw.content_bytes, 'content_bytes', 0, MAX_CONTENT_BYTES);
  const contentSha256 = hexSha(raw.content_sha256, 'content_sha256');

  if (raw.mode === 'raw-inline') {
    if (typeof raw.inline_content !== 'string') fail('CONTENT_REF_INVALID_MANIFEST', 'raw-inline manifest is missing inline_content');
    if (raw.inline_gzip_base64 !== undefined || raw.payload_sha256 !== undefined || raw.payload_bytes !== undefined || raw.stage_encoding !== undefined || raw.chunks !== undefined) fail('CONTENT_REF_INVALID_MANIFEST', 'raw-inline manifest contains incompatible transport fields');
  }

  if (raw.mode === 'gzip-inline') {
    if (typeof raw.inline_gzip_base64 !== 'string' || raw.inline_gzip_base64.length < 1 || raw.inline_gzip_base64.length > MAX_MANIFEST_BYTES) fail('CONTENT_REF_INVALID_MANIFEST', 'gzip-inline manifest is missing bounded inline_gzip_base64');
    integer(raw.payload_bytes, 'payload_bytes', 1, MAX_PAYLOAD_BYTES);
    hexSha(raw.payload_sha256, 'payload_sha256');
    if (raw.inline_content !== undefined || raw.stage_encoding !== undefined || raw.chunks !== undefined) fail('CONTENT_REF_INVALID_MANIFEST', 'gzip-inline manifest contains incompatible transport fields');
  }

  if (raw.mode === 'staged') {
    if (!['identity','gzip'].includes(raw.stage_encoding)) fail('CONTENT_REF_INVALID_MANIFEST', 'staged manifest has an invalid encoding');
    const payloadBytes = integer(raw.payload_bytes, 'payload_bytes', 1, MAX_PAYLOAD_BYTES);
    hexSha(raw.payload_sha256, 'payload_sha256');
    if (!Array.isArray(raw.chunks) || raw.chunks.length < 1 || raw.chunks.length > MAX_CHUNKS) fail('CONTENT_REF_INVALID_MANIFEST', 'staged manifest must contain bounded chunks');
    let summed = 0;
    const indexes = new Set();
    raw.chunks.forEach((chunk, position) => {
      exactFields(chunk, new Set(['index','size','sha256']), `chunks[${position}]`);
      const index = integer(chunk.index, `chunks[${position}].index`, 0, MAX_CHUNKS - 1);
      if (index !== position || indexes.has(index)) fail('CONTENT_REF_INVALID_MANIFEST', 'staged chunk sequence is reordered or duplicated', { position, index });
      indexes.add(index);
      summed += integer(chunk.size, `chunks[${position}].size`, 1, MAX_CHUNK_BYTES);
      hexSha(chunk.sha256, `chunks[${position}].sha256`);
    });
    if (summed !== payloadBytes) fail('CONTENT_REF_INVALID_MANIFEST', 'staged chunk sizes do not equal payload_bytes', { summed, payload_bytes:payloadBytes });
    if (raw.inline_content !== undefined || raw.inline_gzip_base64 !== undefined) fail('CONTENT_REF_INVALID_MANIFEST', 'staged manifest contains incompatible inline fields');
  }

  return { ...raw, createdAt, expiresAt, contentBytes, contentSha256 };
}

function base64ToBytes(value) {
  let binary;
  try { binary = atob(value); } catch { fail('CONTENT_REF_INVALID_MANIFEST', 'gzip-inline payload is not valid base64'); }
  const result = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (result.length > MAX_PAYLOAD_BYTES) fail('CONTENT_REF_PAYLOAD_TOO_LARGE', 'content-reference payload exceeds its bounded size');
  return result;
}

async function gunzipBounded(bytes) {
  if (typeof DecompressionStream !== 'function') fail('CONTENT_REF_DECOMPRESSION_UNAVAILABLE', 'gzip decompression is unavailable in this runtime', null, 500);
  try {
    const stream = new DecompressionStream('gzip');
    const writer = stream.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = toBytes(value);
      total += chunk.length;
      if (total > MAX_CONTENT_BYTES) fail('CONTENT_REF_CONTENT_TOO_LARGE', 'content reference expands beyond the 2 MB UTF-8 limit', { content_bytes:total });
      chunks.push(chunk);
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  } catch (error) {
    if (error instanceof GitHubContentTransportError) throw error;
    fail('CONTENT_REF_DECOMPRESSION_FAILED', 'content reference did not contain valid bounded gzip content');
  }
}

async function bestEffortDelete(storage, key) { try { if (storage && typeof storage.del === 'function') await storage.del(key); } catch { /* temporary cleanup remains best effort */ } }

async function cleanupManifestObjects(storage, id, manifest) {
  if (manifest?.mode === 'staged' && Array.isArray(manifest.chunks)) {
    for (let index = 0; index < manifest.chunks.length; index += 1) await bestEffortDelete(storage, chunkKeyFor(id, index));
  }
  await bestEffortDelete(storage, manifestKeyFor(id));
}

async function writeManifest(storage, id, manifest) {
  const encoded = new TextEncoder().encode(canonicalJson(manifest));
  if (encoded.length > MAX_MANIFEST_BYTES) fail('CONTENT_REF_MANIFEST_TOO_LARGE', 'content-reference manifest exceeds its bounded size');
  await storageApi(storage, 'put').put(manifestKeyFor(id), encoded, 'application/json; charset=utf-8');
}

export const githubContentReferencePolicy = Object.freeze({
  schema:SCHEMA,
  expiry_seconds:EXPIRY_SECONDS,
  max_content_bytes:MAX_CONTENT_BYTES,
  max_payload_bytes:MAX_PAYLOAD_BYTES,
  max_chunks:MAX_CHUNKS,
});

export async function prepareGithubContentReference(content, options = {}) {
  const storage = storageApi(options.storage, 'put');
  const selected = await selectGithubTextTransport(content, options.policy || {});
  const identifier = String((options.idFactory || (() => crypto.randomUUID()))());
  if (!ID.test(identifier)) fail('CONTENT_REF_INVALID_ID', 'generated content-reference ID is invalid', null, 500);
  const created = nowDate(options.now);
  const expires = new Date(created.getTime() + EXPIRY_SECONDS * 1000);
  const common = {
    schema:SCHEMA,
    id:identifier,
    created_at:created.toISOString(),
    expires_at:expires.toISOString(),
    mode:selected.mode,
    content_sha256:selected.content_sha256,
    content_bytes:selected.content_bytes,
  };

  let manifest;
  const writtenChunks = [];
  try {
    if (selected.mode === 'raw-inline') {
      manifest = { ...common, inline_content:selected.content };
    } else if (selected.mode === 'gzip-inline') {
      manifest = {
        ...common,
        inline_gzip_base64:selected.content_gzip_base64,
        payload_sha256:selected.compressed_sha256,
        payload_bytes:selected.compressed_bytes,
      };
    } else {
      const chunks = [];
      for (let index = 0; index < selected.stage_chunks.length; index += 1) {
        const chunk = toBytes(selected.stage_chunks[index]);
        const key = chunkKeyFor(identifier, index);
        await storage.put(key, chunk, 'application/octet-stream');
        writtenChunks.push(key);
        chunks.push({ index, size:chunk.length, sha256:await sha256Bytes(chunk) });
      }
      manifest = {
        ...common,
        stage_encoding:selected.stage_encoding,
        payload_sha256:selected.payload_sha256,
        payload_bytes:selected.payload_bytes,
        chunks,
      };
    }
    await writeManifest(storage, identifier, manifest);
  } catch (error) {
    for (const key of writtenChunks) await bestEffortDelete(storage, key);
    await bestEffortDelete(storage, manifestKeyFor(identifier));
    if (error instanceof GitHubContentTransportError || error?.code === 'INVALID_CONTENT_TRANSPORT') throw error;
    fail(selected.mode === 'staged' ? 'CONTENT_REF_STAGE_WRITE_FAILED' : 'CONTENT_REF_STORAGE_WRITE_FAILED', 'temporary content-reference storage write failed', { mode:selected.mode }, 503);
  }

  return {
    content_ref:`gct1_${identifier}`,
    content_sha256:selected.content_sha256,
    content_bytes:selected.content_bytes,
    expires_at:expires.toISOString(),
  };
}

async function readManifest(storage, id) {
  const stored = await storageApi(storage, 'get').get(manifestKeyFor(id));
  if (!stored?.buffer) fail('CONTENT_REF_NOT_FOUND', 'content reference does not exist or has already been cleaned up', null, 404);
  const bytes = toBytes(stored.buffer);
  if (bytes.length > MAX_MANIFEST_BYTES) fail('CONTENT_REF_INVALID_MANIFEST', 'content-reference manifest exceeds its bounded size');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes)); }
  catch { fail('CONTENT_REF_INVALID_MANIFEST', 'content-reference manifest is not valid UTF-8 JSON'); }
  return validateManifest(parsed, id);
}

export async function resolveGithubContentReference(contentRef, options = {}) {
  const storage = storageApi(options.storage, 'get');
  const { id } = parseReference(contentRef);
  const manifest = await readManifest(storage, id);
  if (nowDate(options.now).getTime() > manifest.expiresAt) {
    await cleanupManifestObjects(storage, id, manifest);
    fail('CONTENT_REF_EXPIRED', 'content reference has expired; prepare the same canonical content again and retry the same semantic changeset', { expires_at:manifest.expires_at }, 410);
  }
  if (manifest.contentBytes > MAX_CONTENT_BYTES) fail('CONTENT_REF_CONTENT_TOO_LARGE', 'content reference exceeds the 2 MB UTF-8 limit');

  let canonicalBytes;
  if (manifest.mode === 'raw-inline') {
    const text = validateText(manifest.inline_content, 'inline_content');
    canonicalBytes = new TextEncoder().encode(text);
  } else if (manifest.mode === 'gzip-inline') {
    const payload = base64ToBytes(manifest.inline_gzip_base64);
    if (payload.length !== manifest.payload_bytes || await sha256Bytes(payload) !== manifest.payload_sha256) fail('CONTENT_REF_PAYLOAD_CHECKSUM_MISMATCH', 'compressed inline payload failed its size or SHA-256 precondition');
    canonicalBytes = await gunzipBounded(payload);
  } else {
    const payload = new Uint8Array(manifest.payload_bytes);
    let offset = 0;
    for (let index = 0; index < manifest.chunks.length; index += 1) {
      const metadata = manifest.chunks[index];
      const stored = await storage.get(chunkKeyFor(id, index));
      if (!stored?.buffer) fail('CONTENT_REF_CHUNK_MISSING', 'staged content-reference chunk is missing', { index });
      const chunk = toBytes(stored.buffer);
      if (chunk.length !== metadata.size || await sha256Bytes(chunk) !== metadata.sha256) fail('CONTENT_REF_CHUNK_CHECKSUM_MISMATCH', 'staged content-reference chunk failed its size or SHA-256 precondition', { index });
      payload.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== manifest.payload_bytes || await sha256Bytes(payload) !== manifest.payload_sha256) fail('CONTENT_REF_PAYLOAD_CHECKSUM_MISMATCH', 'reconstructed staged payload failed its SHA-256 precondition');
    canonicalBytes = manifest.stage_encoding === 'gzip' ? await gunzipBounded(payload) : payload;
  }

  if (canonicalBytes.length > MAX_CONTENT_BYTES) fail('CONTENT_REF_CONTENT_TOO_LARGE', 'content reference expands beyond the 2 MB UTF-8 limit', { content_bytes:canonicalBytes.length });
  if (canonicalBytes.length !== manifest.content_bytes || await sha256Bytes(canonicalBytes) !== manifest.content_sha256) fail('CONTENT_REF_CONTENT_CHECKSUM_MISMATCH', 'resolved canonical content failed its size or SHA-256 precondition');
  let text;
  try { text = new TextDecoder('utf-8', { fatal:true }).decode(canonicalBytes); }
  catch { fail('CONTENT_REF_INVALID_UTF8', 'resolved content reference is not valid UTF-8 text'); }
  return validateText(text);
}

export async function expandGithubContentReferences(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Array.isArray(input.changes)) return input;
  const changes = [];
  for (let index = 0; index < input.changes.length; index += 1) {
    const change = input.changes[index];
    if (!change || typeof change !== 'object' || Array.isArray(change) || change.content_ref === undefined) {
      changes.push(change);
      continue;
    }
    const conflicting = ['content','content_gzip_base64','content_gzip_base64_chunks','content_gzip_base64_sha256','content_gzip_base64_stage'].filter(field => change[field] !== undefined);
    if (conflicting.length) fail('CONTENT_REF_CONFLICT', 'content_ref must be the only content transport on a change', { index, conflicting });
    const content = await resolveGithubContentReference(change.content_ref, options);
    const { content_ref: ignoredContentRef, ...rest } = change;
    changes.push({ ...rest, content });
  }
  return { ...input, changes };
}

export function githubContentTransportErrorResult(error) {
  return {
    ok:false,
    error:error?.code || 'CONTENT_REF_ERROR',
    message:String(error?.message || error),
    ...(error?.details && typeof error.details === 'object' ? error.details : {}),
  };
}