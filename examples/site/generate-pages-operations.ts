import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '../../src/digest.ts';
import {
  GITHUB_API_VERSION,
  GITHUB_OPENAPI_SHA256,
  GITHUB_OPENAPI_SOURCE_COMMIT,
} from '../../src/providers/github/contract.ts';
import {
  deriveGitHubObservationOperation,
  type GitHubOpenApiDocument,
} from '../../src/providers/github/openapi.ts';

const path = process.argv[2];
if (!path)
  throw new Error('usage: generate-pages-operations.ts <pinned-api.github.com.json> [output]');
const source = readFileSync(path, 'utf8');
if (sha256(source) !== GITHUB_OPENAPI_SHA256)
  throw new Error('GITHUB_OPENAPI_SCHEMA_DIGEST_MISMATCH');
const document = JSON.parse(source);
function resolve(value: Record<string, unknown>): Record<string, unknown> {
  const seen = new Set<string>();
  while (typeof value.$ref === 'string') {
    const ref = value.$ref;
    if (!ref.startsWith('#/') || seen.has(ref)) throw new Error('PAGES_SCHEMA_REFERENCE_INVALID');
    seen.add(ref);
    value = ref
      .slice(2)
      .split('/')
      .reduce(
        (current: Record<string, unknown>, part) => current[part] as Record<string, unknown>,
        document,
      );
  }
  return value;
}
function slice(value: unknown, paths: string[]): unknown {
  const schema = resolve(value as Record<string, unknown>);
  if (paths.includes('')) return schema;
  if (schema.type !== 'object') throw new Error('PAGES_SCHEMA_OBJECT_REQUIRED');
  const properties = schema.properties as Record<string, unknown>;
  const selected = [...new Set(paths.map((path) => path.split('.')[0]!))];
  return {
    type: 'object',
    properties: Object.fromEntries(
      selected.map((key) => {
        if (!Object.hasOwn(properties, key)) throw new Error(`PAGES_SCHEMA_PATH_MISSING:${key}`);
        return [
          key,
          slice(
            properties[key],
            paths
              .filter((path) => path === key || path.startsWith(`${key}.`))
              .map((path) => (path === key ? '' : path.slice(key.length + 1))),
          ),
        ];
      }),
    ),
  };
}
const definitions = [
  [
    'PAGES_SETTINGS_OPERATION',
    'repos/get-pages',
    ['source.branch', 'source.path', 'html_url', 'build_type', 'cname', 'public'],
  ],
  [
    'PAGES_BUILD_OPERATION',
    'repos/get-latest-pages-build',
    ['url', 'commit', 'status', 'error.message'],
  ],
] as const;
const generated = definitions.map(([name, id, paths]) => {
  const operation = deriveGitHubObservationOperation(
    document as GitHubOpenApiDocument,
    id,
    GITHUB_API_VERSION,
  );
  const success = operation.outcomes.find((entry) => entry.status === '200');
  if (!success) throw new Error('PAGES_SCHEMA_200_REQUIRED');
  return `export const ${name}: GitHubObservationOperation = ${JSON.stringify({ ...operation, outcomes: [{ ...success, schema: slice(success.schema, [...paths]) }] }, null, 2)};`;
});
writeFileSync(
  process.argv[3] ?? 'src/providers/github/pages-operations.generated.ts',
  [
    '// GENERATED FILE. DO NOT EDIT.',
    `// Source: github/rest-api-description@${GITHUB_OPENAPI_SOURCE_COMMIT}`,
    `// SHA-256: ${GITHUB_OPENAPI_SHA256}`,
    "import type { GitHubObservationOperation } from './openapi.ts';",
    '',
    ...generated,
    '',
  ].join('\n'),
);
