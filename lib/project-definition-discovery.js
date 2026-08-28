function fail(message, details = null) {
  const error = new Error(message);
  error.code = 'PROJECT_DEFINITION_DISCOVERY_INVALID';
  error.details = details;
  throw error;
}

function text(value, field, max = 4096) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) fail(`${field} must be a non-empty string`, { field });
  return normalized;
}

function repositoryPath(value, field) {
  const normalized = text(value, field);
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail(`${field} must be a repository-relative path`, { field, path:normalized });
  }
  return normalized;
}

export const PROJECT_DEFINITION_DISCOVERY_PATH = '.overcenter/project-definitions.json';
export const PROJECT_DEFINITION_DISCOVERY_SCHEMA = 'project-definition-discovery-v1';

export function normalizeProjectDefinitionDiscovery(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('project definition discovery declaration must be an object');
  const supported = ['definitions', 'schema'];
  const keys = Object.keys(input).sort();
  if (keys.length !== supported.length || keys.some((key, index) => key !== supported[index])) {
    fail('project definition discovery declaration contains unsupported fields', { fields:keys });
  }
  if (input.schema !== PROJECT_DEFINITION_DISCOVERY_SCHEMA) {
    fail('project definition discovery declaration schema is unsupported', { schema:input.schema ?? null });
  }
  if (!Array.isArray(input.definitions) || input.definitions.length < 1 || input.definitions.length > 100) {
    fail('definitions must contain between 1 and 100 repository-owned paths');
  }
  const definitions = input.definitions.map((value, index) => repositoryPath(value, `definitions[${index}]`)).sort();
  if (new Set(definitions).size !== definitions.length) fail('definition paths must be unique');
  if (definitions.includes(PROJECT_DEFINITION_DISCOVERY_PATH)) {
    fail('definition discovery declaration cannot select itself', { path:PROJECT_DEFINITION_DISCOVERY_PATH });
  }
  return Object.freeze({
    schema:PROJECT_DEFINITION_DISCOVERY_SCHEMA,
    definitions:Object.freeze(definitions),
  });
}

export function parseProjectDefinitionDiscovery(content) {
  if (typeof content !== 'string' || !content.trim()) fail('project definition discovery declaration content must be non-empty');
  let parsed;
  try { parsed = JSON.parse(content); }
  catch (error) { fail('project definition discovery declaration must contain valid JSON', { cause:String(error?.message || error) }); }
  return normalizeProjectDefinitionDiscovery(parsed);
}
