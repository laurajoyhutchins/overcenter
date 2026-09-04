export const githubTextContentMaxBytes = 10_000_000;

const DEFAULT_POLICY = Object.freeze({
  raw_inline_safe_bytes: 256 * 1024,
  compressed_inline_safe_chars: 1536 * 1024,
  stage_chunk_bytes: 64 * 1024,
  min_compression_savings_ratio: 0.10,
  max_content_bytes: githubTextContentMaxBytes,
});

const LENGTH_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LENGTH_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const DISTANCE_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DISTANCE_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];

function fail(message, details = {}) {
  const error = new Error(message);
  error.code = 'INVALID_CONTENT_TRANSPORT';
  error.details = details;
  throw error;
}

function boundedInteger(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail(`${field} must be an integer from ${minimum} through ${maximum}`, { field, value });
  }
  return number;
}

function boundedRatio(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number >= 1) {
    fail(`${field} must be a number from 0 inclusive to 1 exclusive`, { field, value });
  }
  return number;
}

function normalizePolicy(overrides = {}) {
  const policy = { ...DEFAULT_POLICY, ...(overrides || {}) };
  return {
    raw_inline_safe_bytes: boundedInteger(policy.raw_inline_safe_bytes, 'raw_inline_safe_bytes', 1, 2_000_000),
    compressed_inline_safe_chars: boundedInteger(policy.compressed_inline_safe_chars, 'compressed_inline_safe_chars', 16, 2_000_000),
    stage_chunk_bytes: boundedInteger(policy.stage_chunk_bytes, 'stage_chunk_bytes', 1, 256 * 1024),
    min_compression_savings_ratio: boundedRatio(policy.min_compression_savings_ratio, 'min_compression_savings_ratio'),
    max_content_bytes: boundedInteger(policy.max_content_bytes, 'max_content_bytes', 1, githubTextContentMaxBytes),
  };
}

function validateUnicodeText(value) {
  if (typeof value !== 'string') fail('content must be complete UTF-8 text', { field: 'content' });
  if (value.includes('\u0000')) fail('content must not contain NUL', { field: 'content' });
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('content contains an unpaired Unicode surrogate', { field: 'content' });
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail('content contains an unpaired Unicode surrogate', { field: 'content' });
    }
  }
  return value;
}

async function digestBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function reverseBits(value, width) {
  let reversed = 0;
  for (let index = 0; index < width; index += 1) reversed = (reversed << 1) | ((value >>> index) & 1);
  return reversed >>> 0;
}

function huffmanCodes(lengths) {
  const counts = new Array(16).fill(0);
  for (const length of lengths) if (length > 0) counts[length] += 1;
  const next = new Array(16).fill(0);
  let code = 0;
  for (let bits = 1; bits <= 15; bits += 1) {
    code = (code + counts[bits - 1]) << 1;
    next[bits] = code;
  }
  return lengths.map(length => {
    if (!length) return { code: 0, length: 0 };
    const canonical = next[length]++;
    return { code: reverseBits(canonical, length), length };
  });
}

const FIXED_LITERAL_LENGTHS = Array.from({ length: 288 }, (_, symbol) => {
  if (symbol <= 143) return 8;
  if (symbol <= 255) return 9;
  if (symbol <= 279) return 7;
  return 8;
});
const FIXED_LITERAL_CODES = huffmanCodes(FIXED_LITERAL_LENGTHS);
const FIXED_DISTANCE_CODES = huffmanCodes(new Array(32).fill(5));

class BitWriter {
  constructor() { this.bytes = []; this.current = 0; this.used = 0; }
  write(value, width) {
    for (let index = 0; index < width; index += 1) {
      if ((value >>> index) & 1) this.current |= 1 << this.used;
      this.used += 1;
      if (this.used === 8) { this.bytes.push(this.current); this.current = 0; this.used = 0; }
    }
  }
  finish() { if (this.used > 0) this.bytes.push(this.current); return Uint8Array.from(this.bytes); }
}

function writeSymbol(writer, table, symbol) { const entry = table[symbol]; writer.write(entry.code, entry.length); }

function writeLength(writer, length) {
  for (let index = 0; index < LENGTH_BASE.length; index += 1) {
    const base = LENGTH_BASE[index];
    const extra = LENGTH_EXTRA[index];
    const maximum = base + (extra ? (1 << extra) - 1 : 0);
    if (length <= maximum) {
      writeSymbol(writer, FIXED_LITERAL_CODES, 257 + index);
      if (extra) writer.write(length - base, extra);
      return;
    }
  }
  fail('deflate match length is out of range', { length });
}

function writeDistance(writer, distance) {
  for (let index = 0; index < DISTANCE_BASE.length; index += 1) {
    const base = DISTANCE_BASE[index];
    const extra = DISTANCE_EXTRA[index];
    const maximum = base + (extra ? (1 << extra) - 1 : 0);
    if (distance <= maximum) {
      writeSymbol(writer, FIXED_DISTANCE_CODES, index);
      if (extra) writer.write(distance - base, extra);
      return;
    }
  }
  fail('deflate match distance is out of range', { distance });
}

function deflateFixed(bytes) {
  const writer = new BitWriter();
  writer.write(1, 1);
  writer.write(1, 2);
  const positions = new Map();
  function keyAt(index) { return index + 2 >= bytes.length ? null : (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2]; }
  function remember(index) {
    const key = keyAt(index);
    if (key === null) return;
    let list = positions.get(key);
    if (!list) { list = []; positions.set(key, list); }
    list.push(index);
    const cutoff = index - 32768;
    while (list.length && list[0] < cutoff) list.shift();
    if (list.length > 64) list.splice(0, list.length - 64);
  }
  let index = 0;
  while (index < bytes.length) {
    let bestLength = 0;
    let bestDistance = 0;
    const key = keyAt(index);
    const candidates = key === null ? null : positions.get(key);
    if (candidates) {
      const maximum = Math.min(258, bytes.length - index);
      let inspected = 0;
      for (let candidateIndex = candidates.length - 1; candidateIndex >= 0 && inspected < 32; candidateIndex -= 1, inspected += 1) {
        const previous = candidates[candidateIndex];
        const distance = index - previous;
        if (distance < 1 || distance > 32768) continue;
        let length = 0;
        while (length < maximum && bytes[previous + length] === bytes[index + length]) length += 1;
        if (length >= 3 && length > bestLength) { bestLength = length; bestDistance = distance; if (bestLength === maximum) break; }
      }
    }
    if (bestLength >= 3) {
      writeLength(writer, bestLength); writeDistance(writer, bestDistance);
      for (let offset = 0; offset < bestLength; offset += 1) remember(index + offset);
      index += bestLength;
    } else {
      writeSymbol(writer, FIXED_LITERAL_CODES, bytes[index]); remember(index); index += 1;
    }
  }
  writeSymbol(writer, FIXED_LITERAL_CODES, 256);
  return writer.finish();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function littleEndian32(value) { return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]; }
function gzipBytes(bytes) {
  const deflated = deflateFixed(bytes);
  const header = Uint8Array.from([0x1f,0x8b,0x08,0x00,0x00,0x00,0x00,0x00,0x00,0xff]);
  const trailer = Uint8Array.from([...littleEndian32(crc32(bytes)), ...littleEndian32(bytes.length >>> 0)]);
  const result = new Uint8Array(header.length + deflated.length + trailer.length);
  result.set(header, 0); result.set(deflated, header.length); result.set(trailer, header.length + deflated.length);
  return result;
}

function bytesToBase64(bytes) {
  let binary = '';
  const window = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += window) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + window, bytes.length)));
  return btoa(binary);
}
function chunkBytes(bytes, chunkSize) { const chunks = []; for (let offset = 0; offset < bytes.length; offset += chunkSize) chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.length))); return chunks; }

export const githubTextTransportPolicy = DEFAULT_POLICY;

export async function selectGithubTextTransport(content, policyOverrides = {}) {
  const policy = normalizePolicy(policyOverrides);
  const text = validateUnicodeText(content);
  const rawBytes = new TextEncoder().encode(text);
  if (rawBytes.length > policy.max_content_bytes) fail(`content expands beyond the ${policy.max_content_bytes} byte limit`, { content_bytes: rawBytes.length, max_content_bytes: policy.max_content_bytes });
  const contentSha256 = await digestBytes(rawBytes);
  if (rawBytes.length <= policy.raw_inline_safe_bytes) return { mode:'raw-inline', content:text, content_bytes:rawBytes.length, content_sha256:contentSha256 };
  const compressedBytes = gzipBytes(rawBytes);
  const encoded = bytesToBase64(compressedBytes);
  const compressionSavingsRatio = rawBytes.length === 0 ? 0 : 1 - (compressedBytes.length / rawBytes.length);
  if (encoded.length <= policy.compressed_inline_safe_chars) return { mode:'gzip-inline', content_gzip_base64:encoded, content_bytes:rawBytes.length, compressed_bytes:compressedBytes.length, encoded_chars:encoded.length, content_sha256:contentSha256, compressed_sha256:await digestBytes(compressedBytes), compression_savings_ratio:compressionSavingsRatio };
  const useCompression = compressionSavingsRatio >= policy.min_compression_savings_ratio;
  const stagePayload = useCompression ? compressedBytes : rawBytes;
  return { mode:'staged', stage_encoding:useCompression ? 'gzip' : 'identity', stage_chunks:chunkBytes(stagePayload, policy.stage_chunk_bytes), content_bytes:rawBytes.length, payload_bytes:stagePayload.length, content_sha256:contentSha256, payload_sha256:await digestBytes(stagePayload), compression_savings_ratio:compressionSavingsRatio };
}