import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const providerSpecifiers = [
  /^hatchable$/,
  /^pg$/,
  /^@google-cloud\//,
  /^@aws-sdk\//,
];
const allowedProviderImporters = new Set([
  'lib/hatchable-runtime-providers.js',
  'scripts/cloud-run.mjs',
]);

function isProviderSpecifier(specifier) {
  return providerSpecifiers.some(pattern => pattern.test(specifier));
}

function localSpecifier(importer, specifier) {
  if (specifier.startsWith('lib/')) return specifier;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return normalize(relative(root, resolve(root, dirname(importer), specifier))).replaceAll('\\', '/');
  }
  return null;
}

function staticImports(source) {
  const imports = [];
  const pattern = /(?:import|export)\s+(?:[^'\";]*?\s+from\s+)?['\"]([^'\"]+)['\"]/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

async function exists(path) {
  try { await access(join(root, path)); return true; }
  catch { return false; }
}

async function semanticRoots() {
  const mcp = (await readdir(join(root, 'mcp')))
    .filter(name => name.endsWith('.js'))
    .map(name => `mcp/${name}`);
  return ['api/worker-command.js', 'lib/worker-command-handler.js', 'lib/worker-transport.js', ...mcp];
}

async function providerViolations() {
  const pending = await semanticRoots();
  const visited = new Set();
  const violations = [];

  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path) || !(await exists(path))) continue;
    visited.add(path);
    const source = await readFile(join(root, path), 'utf8');
    for (const specifier of staticImports(source)) {
      if (isProviderSpecifier(specifier) && !allowedProviderImporters.has(path)) {
        violations.push(`${path} -> ${specifier}`);
      }
      const local = localSpecifier(path, specifier);
      if (local && local.endsWith('.js')) pending.push(local);
    }
  }

  return violations.sort();
}

test('semantic execution cone imports provider SDKs only from explicit adapters', async () => {
  const violations = await providerViolations();
  assert.deepEqual(violations, []);
});

test('semantic runtime composition requires explicit substitutable capabilities', async () => {
  const { createSemanticRuntime } = await import(pathToFileURL(join(root, 'lib/semantic-runtime.js')));
  const providers = {
    db: { query: async () => ({ rows: [] }) },
    secrets: { get: async name => `secret:${name}` },
    githubAuth: { withGitHubAppApiClient: async (_repo, callback) => callback({}) },
    storage: {
      put: async () => 'object://ref',
      get: async () => ({ buffer: new Uint8Array(), contentType: 'application/octet-stream' }),
      del: async () => {},
    },
  };
  const runtime = createSemanticRuntime(providers);
  assert.equal(runtime.db, providers.db);
  assert.equal(runtime.secrets, providers.secrets);
  assert.equal(runtime.githubAuth, providers.githubAuth);
  assert.equal(runtime.storage, providers.storage);

  for (const missing of ['db', 'secrets', 'githubAuth', 'storage']) {
    const incomplete = { ...providers };
    delete incomplete[missing];
    assert.throws(
      () => createSemanticRuntime(incomplete),
      error => error?.code === 'RUNTIME_PROVIDER_REQUIRED' && error?.details?.provider === missing,
      `missing ${missing} must fail closed`,
    );
  }
});