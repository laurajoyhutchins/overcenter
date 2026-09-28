export type JsonObject = Record<string, unknown>;

interface OpenApiParameter extends JsonObject {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: unknown;
}

interface OpenApiOperation extends JsonObject {
  operationId?: string;
  parameters?: Array<OpenApiParameter | { $ref: string }>;
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: unknown }> }
  >;
  'x-github'?: JsonObject;
}

interface OpenApiPathItem extends JsonObject {
  parameters?: Array<OpenApiParameter | { $ref: string }>;
  get?: OpenApiOperation;
  head?: OpenApiOperation;
}

export interface GitHubOpenApiDocument extends JsonObject {
  paths?: Record<string, OpenApiPathItem>;
  components?: JsonObject;
}

export interface GitHubObservationParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  schema: unknown;
}

export interface GitHubPagePagination {
  kind: 'page-number';
  page_parameter: string;
  page_size_parameter: string;
  first_page: number;
  default_page_size: number;
}

export interface GitHubObservationOperation {
  provider: 'github';
  api_version: string;
  method: 'GET' | 'HEAD';
  path_template: string;
  operation_id: string;
  parameters: GitHubObservationParameter[];
  pagination?: GitHubPagePagination;
  outcomes: Array<{ status: string; description: string; schema: unknown }>;
  github_extensions: Record<string, unknown>;
}

export interface MaterializedGitHubOperationRequest {
  path: string;
  parameters: Record<string, string | number | boolean>;
  headers: Record<string, string>;
}

function resolveLocalRef(document: GitHubOpenApiDocument, value: unknown): unknown {
  let current = value;
  const seen = new Set<string>();
  while (current !== null && typeof current === 'object' && !Array.isArray(current)) {
    const ref = (current as JsonObject).$ref;
    if (typeof ref !== 'string') return current;
    if (!ref.startsWith('#/')) throw new Error(`GITHUB_OPENAPI_EXTERNAL_REF_UNSUPPORTED:${ref}`);
    if (seen.has(ref)) throw new Error(`GITHUB_OPENAPI_REF_CYCLE:${ref}`);
    seen.add(ref);
    let resolved: unknown = document;
    for (const segment of ref.slice(2).split('/')) {
      if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) {
        throw new Error(`GITHUB_OPENAPI_REF_NOT_FOUND:${ref}`);
      }
      resolved = (resolved as JsonObject)[segment];
    }
    if (resolved === undefined) throw new Error(`GITHUB_OPENAPI_REF_NOT_FOUND:${ref}`);
    current = resolved;
  }
  return current;
}

function normalizeParameter(
  document: GitHubOpenApiDocument,
  value: OpenApiParameter | { $ref: string },
): GitHubObservationParameter {
  const parameter = resolveLocalRef(document, value) as OpenApiParameter;
  if (
    typeof parameter.name !== 'string' ||
    !['path', 'query', 'header'].includes(String(parameter.in))
  ) {
    throw new Error('GITHUB_OPENAPI_PARAMETER_UNSUPPORTED');
  }
  return {
    name: parameter.name,
    in: parameter.in as GitHubObservationParameter['in'],
    required: parameter.in === 'path' || parameter.required === true,
    schema: resolveLocalRef(document, parameter.schema ?? null),
  };
}

function mergeParameters(
  document: GitHubOpenApiDocument,
  pathParameters: Array<OpenApiParameter | { $ref: string }> = [],
  operationParameters: Array<OpenApiParameter | { $ref: string }> = [],
): GitHubObservationParameter[] {
  const merged = new Map<string, GitHubObservationParameter>();
  for (const parameter of [...pathParameters, ...operationParameters]) {
    const normalized = normalizeParameter(document, parameter);
    merged.set(`${normalized.in}:${normalized.name}`, normalized);
  }
  return [...merged.values()].sort((left, right) =>
    `${left.in}:${left.name}`.localeCompare(`${right.in}:${right.name}`),
  );
}

function integerDefault(parameter: GitHubObservationParameter | undefined): number | null {
  if (!parameter || parameter.in !== 'query') return null;
  const schema = parameter.schema;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return null;
  const body = schema as JsonObject;
  if (body.type !== 'integer' || !Number.isSafeInteger(body.default)) return null;
  return body.default as number;
}

function derivePagePagination(
  parameters: GitHubObservationParameter[],
): GitHubPagePagination | undefined {
  const page = parameters.find(
    (parameter) => parameter.in === 'query' && parameter.name === 'page',
  );
  const pageSize = parameters.find(
    (parameter) => parameter.in === 'query' && parameter.name === 'per_page',
  );
  if (!page || !pageSize) return undefined;

  const firstPage = integerDefault(page);
  const defaultPageSize = integerDefault(pageSize);
  if (firstPage === null || defaultPageSize === null || firstPage < 1 || defaultPageSize < 1) {
    throw new Error('GITHUB_OPENAPI_PAGE_PAGINATION_DEFAULT_INVALID');
  }

  return {
    kind: 'page-number',
    page_parameter: page.name,
    page_size_parameter: pageSize.name,
    first_page: firstPage,
    default_page_size: defaultPageSize,
  };
}

export function deriveGitHubObservationOperation(
  document: GitHubOpenApiDocument,
  operationId: string,
  apiVersion: string,
): GitHubObservationOperation {
  let found: {
    pathTemplate: string;
    method: 'get' | 'head';
    pathItem: OpenApiPathItem;
    operation: OpenApiOperation;
  } | null = null;
  for (const [pathTemplate, pathItem] of Object.entries(document.paths ?? {})) {
    for (const method of ['get', 'head'] as const) {
      const operation = pathItem[method];
      if (operation?.operationId !== operationId) continue;
      if (found) throw new Error(`GITHUB_OPENAPI_OPERATION_ID_DUPLICATE:${operationId}`);
      found = { pathTemplate, method, pathItem, operation };
    }
  }
  if (!found) throw new Error(`GITHUB_OPENAPI_OPERATION_NOT_FOUND:${operationId}`);

  const parameters = mergeParameters(
    document,
    found.pathItem.parameters,
    found.operation.parameters,
  );
  const pagination = derivePagePagination(parameters);
  const outcomes = Object.entries(found.operation.responses ?? {})
    .map(([status, response]) => ({
      status,
      description: typeof response.description === 'string' ? response.description : '',
      schema: response.content?.['application/json']?.schema ?? null,
    }))
    .sort((left, right) => left.status.localeCompare(right.status, undefined, { numeric: true }));

  return {
    provider: 'github',
    api_version: apiVersion,
    method: found.method.toUpperCase() as 'GET' | 'HEAD',
    path_template: found.pathTemplate,
    operation_id: operationId,
    parameters,
    ...(pagination ? { pagination } : {}),
    outcomes,
    github_extensions: found.operation['x-github'] ?? {},
  };
}

export function materializeGitHubOperationRequest(
  operation: GitHubObservationOperation,
  values: Record<string, string | number | boolean>,
): MaterializedGitHubOperationRequest {
  const declared = new Set(operation.parameters.map((parameter) => parameter.name));
  for (const name of Object.keys(values)) {
    if (!declared.has(name)) throw new Error(`GITHUB_OPERATION_PARAMETER_UNKNOWN:${name}`);
  }

  let path = operation.path_template;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  const parameters: Record<string, string | number | boolean> = {};

  for (const parameter of operation.parameters) {
    const value = values[parameter.name];
    if (value === undefined) {
      if (parameter.required)
        throw new Error(`GITHUB_OPERATION_PARAMETER_REQUIRED:${parameter.name}`);
      continue;
    }
    parameters[parameter.name] = value;
    if (parameter.in === 'path')
      path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
    if (parameter.in === 'query') query.append(parameter.name, String(value));
    if (parameter.in === 'header') headers[parameter.name] = String(value);
  }

  if (/\{[^}]+\}/.test(path)) throw new Error('GITHUB_OPERATION_PATH_UNRESOLVED');
  const suffix = query.toString();
  return { path: suffix ? `${path}?${suffix}` : path, parameters, headers };
}
