function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function text(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail('PROJECT_GRAPH_DERIVATION_DECLARATION_INVALID', `${field} must be a non-empty string`, { field });
  return normalized;
}

export const PROJECT_GRAPH_DERIVATION_DECLARATION_PATH = '.overcenter/project-graph.json';
export const PROJECT_GRAPH_DERIVATION_DECLARATION_SCHEMA = 'project-graph-derivation-v1';

export function normalizeProjectGraphDerivationDeclaration(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('PROJECT_GRAPH_DERIVATION_DECLARATION_INVALID', 'project graph derivation declaration must be an object');
  }

  const keys = Object.keys(input).sort();
  const supported = ['derivation', 'schema'];
  if (keys.length !== supported.length || keys.some((key, index)=>key !== supported[index])) {
    fail('PROJECT_GRAPH_DERIVATION_DECLARATION_INVALID', 'project graph derivation declaration contains unsupported fields', { fields:keys });
  }

  if (input.schema !== PROJECT_GRAPH_DERIVATION_DECLARATION_SCHEMA) {
    fail('PROJECT_GRAPH_DERIVATION_DECLARATION_INVALID', 'project graph derivation declaration schema is unsupported', { schema:input.schema ?? null });
  }

  const derivation = text(input.derivation, 'derivation');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(derivation)) {
    fail('PROJECT_GRAPH_DERIVATION_DECLARATION_INVALID', 'derivation must be a stable registered identifier', { derivation });
  }

  return Object.freeze({
    schema:PROJECT_GRAPH_DERIVATION_DECLARATION_SCHEMA,
    derivation,
  });
}

export function parseProjectGraphDerivationDeclaration(content) {
  const source = typeof content === 'string' ? content.trim() : '';
  if (!source) {
    fail('PROJECT_GRAPH_DERIVATION_DECLARATION_INVALID', 'project graph derivation declaration content must be non-empty');
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    fail('PROJECT_GRAPH_DERIVATION_DECLARATION_INVALID', 'project graph derivation declaration must contain valid JSON', { cause:String(error?.message || error) });
  }

  return normalizeProjectGraphDerivationDeclaration(parsed);
}
