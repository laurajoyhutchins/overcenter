function fail(message, details = null) {
  const error = new Error(message);
  error.code = 'PROJECT_DEFINITION_FACTS_INVALID';
  error.details = details;
  throw error;
}

function text(value, field, max = 16384) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) fail(`${field} must be a non-empty string`, { field });
  return normalized;
}

function exactContent(value, field, maxBytes = 250000) {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be non-empty UTF-8 text`, { field });
  const byteLength = new TextEncoder().encode(value).length;
  if (byteLength > maxBytes) fail(`${field} exceeds the bounded UTF-8 size`, { field, byte_length:byteLength, max_bytes:maxBytes });
  return value;
}

function exactRevision(value, field = 'revision') {
  const revision = text(value, field, 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(revision)) fail(`${field} must be a full Git commit SHA`, { field, revision });
  return revision;
}

function digest(value, field) {
  const normalized = text(value, field, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) fail(`${field} must be a SHA-256 digest`, { field });
  return normalized;
}

function path(value, field) {
  const normalized = text(value, field, 4096);
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail(`${field} must be a repository-relative path`, { field, path:normalized });
  }
  return normalized;
}

function normalizeDefinition(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('definition must be an object', { index });
  const supported = ['blob_sha', 'content', 'media_type', 'path', 'sha256'];
  const keys = Object.keys(input).sort();
  if (keys.length !== supported.length || keys.some((key, keyIndex) => key !== supported[keyIndex])) {
    fail('definition contains unsupported fields', { index, fields:keys });
  }
  const blobSha = text(input.blob_sha, `definitions[${index}].blob_sha`, 40).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(blobSha)) fail('definition blob_sha must be a Git object SHA', { index });
  return Object.freeze({
    path:path(input.path, `definitions[${index}].path`),
    blob_sha:blobSha,
    sha256:digest(input.sha256, `definitions[${index}].sha256`),
    media_type:text(input.media_type, `definitions[${index}].media_type`, 256),
    content:exactContent(input.content, `definitions[${index}].content`),
  });
}

export const PROJECT_DEFINITION_FACTS_SCHEMA = 'project-definition-facts-v1';

export function normalizeProjectDefinitionFacts(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('project definition facts must be an object');
  const supported = ['definitions', 'repository', 'revision', 'schema'];
  const keys = Object.keys(input).sort();
  if (keys.length !== supported.length || keys.some((key, index) => key !== supported[index])) {
    fail('project definition facts contain unsupported fields', { fields:keys });
  }
  if (input.schema !== PROJECT_DEFINITION_FACTS_SCHEMA) fail('project definition facts schema is unsupported', { schema:input.schema ?? null });
  const repository = text(input.repository, 'repository', 256);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) fail('repository must be an explicit owner/name coordinate', { repository });
  if (!Array.isArray(input.definitions) || input.definitions.length < 1 || input.definitions.length > 100) {
    fail('definitions must contain between 1 and 100 exact-revision repository documents');
  }
  const definitions = input.definitions.map(normalizeDefinition).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(definitions.map((entry) => entry.path)).size !== definitions.length) fail('definition paths must be unique');
  return Object.freeze({
    schema:PROJECT_DEFINITION_FACTS_SCHEMA,
    repository,
    revision:exactRevision(input.revision),
    definitions:Object.freeze(definitions),
  });
}
