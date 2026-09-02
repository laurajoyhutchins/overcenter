export const CONTRACT_CATALOG_SCHEMA = 'contract-evidence-catalog-v1';
export const CONTRACT_CLASSIFICATION_SCHEMA = 'contract-evidence-classifications-v1';
export const SIGNIFICANCE_CLASSES = Object.freeze([
  'public',
  'authority',
  'durable-internal',
  'boundary-internal',
  'projection',
  'implementation-only',
]);
export const CONTRACT_LIFECYCLES = Object.freeze([
  'current',
  'compatibility',
  'deprecated',
  'deletion-candidate',
]);
export const CONTRACT_RELATIONSHIP_KINDS = Object.freeze([
  'consumes',
  'produces',
  'persists-as',
  'derives-from',
  'verified-by',
  'compatibility-for',
]);

const SIGNIFICANCE = new Set(SIGNIFICANCE_CLASSES);
const LIFECYCLE = new Set(CONTRACT_LIFECYCLES);
const RELATIONSHIP_KIND = new Set(CONTRACT_RELATIONSHIP_KINDS);
const CANDIDATE_KEYS = new Set([
  'source_identity',
  'source_kind',
  'source_location',
  'symbol_or_boundary',
  'structural_fingerprint',
  'structure',
  'observed_relationships',
]);
const CLASSIFICATION_KEYS = new Set([
  'logical_contract',
  'significance',
  'projection_of',
  'semver_kind',
  'lifecycle',
  'relationships',
]);
const SCHEMA_DUPLICATION_KEYS = new Set([
  'properties',
  'fields',
  'allowed_values',
  'validation',
  'required',
  'type',
  'enum',
  'constraints',
]);

function failure(code, message, details = null) {
  const error = new Error(message);
  Object.assign(error, { code, details });
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertCandidate(candidate) {
  if (!isRecord(candidate)) throw failure('CONTRACT_CANDIDATE_INVALID', 'candidate must be an object');
  const unknown = Object.keys(candidate).filter((key) => !CANDIDATE_KEYS.has(key));
  if (unknown.length) throw failure('CONTRACT_CANDIDATE_INVALID', 'candidate contains unsupported fields', { unknown:unknown.sort() });

  if (!nonEmptyString(candidate.source_identity)) throw failure('CONTRACT_CANDIDATE_INVALID', 'source_identity is required');
  if (!nonEmptyString(candidate.source_kind)) throw failure('CONTRACT_CANDIDATE_INVALID', 'source_kind is required');
  if (!isRecord(candidate.source_location) || !nonEmptyString(candidate.source_location.path)) {
    throw failure('CONTRACT_CANDIDATE_INVALID', 'source_location.path is required');
  }
  if (candidate.source_location.anchor !== undefined && !nonEmptyString(candidate.source_location.anchor)) {
    throw failure('CONTRACT_CANDIDATE_INVALID', 'source_location.anchor must be a non-empty string when present');
  }
  if (!nonEmptyString(candidate.symbol_or_boundary)) throw failure('CONTRACT_CANDIDATE_INVALID', 'symbol_or_boundary is required');
  if (!/^sha256:[0-9a-f]{64}$/.test(candidate.structural_fingerprint || '')) {
    throw failure('CONTRACT_CANDIDATE_INVALID', 'structural_fingerprint must be a lowercase sha256 digest');
  }
  if (!isRecord(candidate.structure) && !Array.isArray(candidate.structure)) {
    throw failure('CONTRACT_CANDIDATE_INVALID', 'structure must be an object or array');
  }
  if (!Array.isArray(candidate.observed_relationships)) {
    throw failure('CONTRACT_CANDIDATE_INVALID', 'observed_relationships must be an array');
  }
  for (const relationship of candidate.observed_relationships) {
    if (!isRecord(relationship) || !nonEmptyString(relationship.kind)) {
      throw failure('CONTRACT_CANDIDATE_INVALID', 'observed relationships must be objects with a kind');
    }
  }
  return candidate;
}

export function assertClassificationDocument(document) {
  if (!isRecord(document)) throw failure('CONTRACT_CLASSIFICATION_INVALID', 'classification document must be an object');
  const documentKeys = Object.keys(document).sort();
  if (documentKeys.length !== 2 || !documentKeys.includes('schema') || !documentKeys.includes('candidates')) {
    throw failure('CONTRACT_CLASSIFICATION_INVALID', 'classification document must contain only schema and candidates');
  }
  if (document.schema !== CONTRACT_CLASSIFICATION_SCHEMA) {
    throw failure('CONTRACT_CLASSIFICATION_INVALID', 'unsupported classification schema', { schema:document.schema ?? null });
  }
  if (!isRecord(document.candidates)) throw failure('CONTRACT_CLASSIFICATION_INVALID', 'candidates must be an object');

  for (const [sourceIdentity, entry] of Object.entries(document.candidates)) {
    if (!nonEmptyString(sourceIdentity) || !isRecord(entry)) {
      throw failure('CONTRACT_CLASSIFICATION_INVALID', 'classification entries must be keyed by source identity');
    }
    const duplicateKeys = Object.keys(entry).filter((key) => SCHEMA_DUPLICATION_KEYS.has(key));
    if (duplicateKeys.length) {
      throw failure(
        'CONTRACT_CLASSIFICATION_SCHEMA_DUPLICATION',
        'classification metadata cannot restate contract schema',
        { source_identity:sourceIdentity, forbidden:duplicateKeys.sort() },
      );
    }
    const unknown = Object.keys(entry).filter((key) => !CLASSIFICATION_KEYS.has(key));
    if (unknown.length) {
      throw failure('CONTRACT_CLASSIFICATION_INVALID', 'classification entry contains unsupported fields', { source_identity:sourceIdentity, unknown:unknown.sort() });
    }
    if (!SIGNIFICANCE.has(entry.significance)) {
      throw failure('CONTRACT_CLASSIFICATION_INVALID', 'classification significance is invalid', { source_identity:sourceIdentity, significance:entry.significance ?? null });
    }
    if (entry.lifecycle !== undefined && !LIFECYCLE.has(entry.lifecycle)) {
      throw failure('CONTRACT_CLASSIFICATION_INVALID', 'classification lifecycle is invalid', { source_identity:sourceIdentity, lifecycle:entry.lifecycle ?? null });
    }
    if (entry.relationships !== undefined) {
      if (!Array.isArray(entry.relationships)) {
        throw failure('CONTRACT_CLASSIFICATION_INVALID', 'classification relationships must be an array', { source_identity:sourceIdentity });
      }
      for (const [index, relationship] of entry.relationships.entries()) {
        if (!isRecord(relationship)) {
          throw failure('CONTRACT_CLASSIFICATION_INVALID', 'classification relationship must be an object', { source_identity:sourceIdentity, index });
        }
        const relationshipUnknown = Object.keys(relationship).filter((key) => key !== 'kind' && key !== 'target');
        if (relationshipUnknown.length || !RELATIONSHIP_KIND.has(relationship.kind) || !nonEmptyString(relationship.target)) {
          throw failure('CONTRACT_CLASSIFICATION_INVALID', 'classification relationship is invalid', { source_identity:sourceIdentity, index, unknown:relationshipUnknown.sort(), kind:relationship.kind ?? null, target:relationship.target ?? null });
        }
      }
    }
    if (entry.significance === 'projection' && (entry.lifecycle !== undefined || (entry.relationships?.length || 0) > 0)) {
      throw failure('CONTRACT_CLASSIFICATION_INVALID', 'projection classifications cannot define logical lifecycle or relationships', { source_identity:sourceIdentity });
    }
    for (const field of ['logical_contract','projection_of','semver_kind']) {
      if (entry[field] !== undefined && !nonEmptyString(entry[field])) {
        throw failure('CONTRACT_CLASSIFICATION_INVALID', `${field} must be a non-empty string when present`, { source_identity:sourceIdentity });
      }
    }
  }
  return document;
}
