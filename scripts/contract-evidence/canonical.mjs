import { createHash } from 'node:crypto';

function fail(message, details = null) {
  const error = new Error(message);
  Object.assign(error, { code:'CONTRACT_SOURCE_IDENTITY_INVALID', details });
  throw error;
}

function normalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON does not support non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined) throw new TypeError(`canonical JSON does not support undefined at ${key}`);
      output[key] = normalize(item);
    }
    return output;
  }
  throw new TypeError(`canonical JSON does not support ${typeof value}`);
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function fingerprintStructure(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

export function sourceIdentity(kind, path, anchor) {
  const normalizedKind = typeof kind === 'string' ? kind.trim() : '';
  const normalizedAnchor = typeof anchor === 'string' ? anchor.trim() : '';
  let normalizedPath = typeof path === 'string' ? path.trim().replaceAll('\\', '/') : '';
  while (normalizedPath.startsWith('./')) normalizedPath = normalizedPath.slice(2);
  const segments = normalizedPath.split('/');
  if (!normalizedKind || !normalizedPath || !normalizedAnchor || segments.includes('..') || segments.includes('')) {
    fail('contract source identity contains invalid coordinates', { kind:normalizedKind, path:normalizedPath, anchor:normalizedAnchor });
  }
  return `${normalizedKind}:${normalizedPath}#${normalizedAnchor.replaceAll('#', '%23')}`;
}
