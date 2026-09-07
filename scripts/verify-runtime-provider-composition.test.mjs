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
  return ['api/worker-command.js', 'api/github-integration-reconcile.js', 'api/scheduled-execution/bootstrap.js', 'api/scheduled-execution/command.js', 'lib/worker-command-handler.js', 'lib/worker-transport.js', ...mcp];
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
  const { createRuntimeProviders } = await import(pathToFileURL(join(root, 'lib/runtime-providers.js')));
  const providers = {
    db: { query: async () => ({ rows: [] }) },
    secrets: { get: async name => `secret:${name}` },
    githubAppAuth: { withApiClient: async (_repo, callback) => callback({}) },
    storage: {
      put: async () => 'object://ref',
      get: async () => ({ buffer: new Uint8Array(), contentType: 'application/octet-stream' }),
      del: async () => {},
    },
    api: { call: async () => ({}) },
  };
  const runtime = createRuntimeProviders(providers);
  assert.equal(runtime.db, providers.db);
  assert.equal(runtime.secrets, providers.secrets);
  assert.equal(runtime.githubAppAuth, providers.githubAppAuth);
  assert.equal(runtime.storage, providers.storage);
  assert.equal(runtime.api, providers.api);

  for (const missing of ['db', 'secrets', 'githubAppAuth', 'storage', 'api']) {
    const incomplete = { ...providers };
    delete incomplete[missing];
    assert.throws(
      () => createRuntimeProviders(incomplete),
      error => error?.code === 'RUNTIME_PROVIDER_MISSING' && error?.details?.provider === missing,
      `missing ${missing} must fail closed`,
    );
  }
});

test('authoritative-effect runtime injects API and GitHub auth providers into execution authority', async () => {
  const source = await readFile(join(root, 'lib/project-transition-authoritative-effect-github-runtime.js'), 'utf8');
  assert.match(
    source,
    /createPostgresExecutionAuthorityService\(\{\s*db,\s*api:options\.api,\s*withGitHubAppApiClient:withApp,?\s*\}\)/,
    'authoritative-effect confirmation must forward explicit API and GitHub auth providers to execution authority',
  );
});

test('review integration preserves the explicit GitHub auth capability', async () => {
  const reviewSource = await readFile(join(root, 'lib/github-review-packet.js'), 'utf8');
  const integrationSource = await readFile(join(root, 'lib/github-integration.js'), 'utf8');
  assert.doesNotMatch(reviewSource, /import\s+\{\s*withGitHubAppApiClient\s*\}\s+from\s+['\"]lib\/github-app-auth\.js['\"]/, 'review packet must not import ambient GitHub auth');
  assert.match(reviewSource, /const\s+withApp\s*=\s*options\.withGitHubAppApiClient/, 'review packet must require injected GitHub auth');
  assert.match(integrationSource, /withGitHubAppApiClient\s*:\s*withApp/, 'integration must forward injected GitHub auth into review');
});

test('GitHub project graph runtime requires an explicit auth capability', async () => {
  const { createGitHubProjectGraphRuntime } = await import(pathToFileURL(join(root, 'lib/project-graph-github-runtime.js')));
  const db = { query: async () => ({ rows: [] }) };
  const definitionFacts = async () => ({ schema:'project-definition-facts-v1' });

  assert.throws(
    () => createGitHubProjectGraphRuntime({ db, readProjectDefinitionFactsWithGitHubApp:definitionFacts }),
    error => error?.code === 'PROJECT_GRAPH_GITHUB_READER_UNAVAILABLE',
    'graph runtime must not fall back to ambient GitHub auth',
  );

  const runtime = createGitHubProjectGraphRuntime({
    db,
    withGitHubAppApiClient:async () => {},
    readProjectDefinitionFactsWithGitHubApp:definitionFacts,
  });
  assert.equal(typeof runtime.resolveProjectAuthority, 'function');
});

test('semantic GitHub auth does not hide provider resolution below composition roots', async () => {
  for (const path of [
    'lib/project-definition-facts-reader.js',
    'lib/production-promotion-overcenter-host.js',
    'lib/github-production-promotion-runtime.js',
    'lib/production-reconcile-overcenter-host.js',
  ]) {
    const text = await readFile(join(root, path), 'utf8');
    assert.doesNotMatch(text, /import\(['\"]\.\/github-app-auth\.js['\"]\)/, `${path} dynamically resolves GitHub auth`);
    assert.doesNotMatch(text, /from\s+['\"][^'\"]*github-app-auth\.js['\"]/, `${path} imports an unbound GitHub auth implementation`);
  }

  const integrationRecovery = await readFile(join(root, 'api/github-integration-reconcile.js'), 'utf8');
  assert.match(integrationRecovery, /withGitHubAppApiClient:providers\.githubAppAuth\.withApiClient/, 'integration recovery root must forward the bound GitHub auth provider');

  const worker = await readFile(join(root, 'lib/worker-transport.js'), 'utf8');
  assert.match(worker, /productionReconciliationFor\(\{\s*db:requireRuntimeDb\(runtime\),\s*withGitHubAppApiClient:requireGitHubAppAuth\(runtime\)\.withApiClient,/s);
  assert.match(worker, /productionPromotionFor\(\{\s*db:requireRuntimeDb\(runtime\),\s*withGitHubAppApiClient:requireGitHubAppAuth\(runtime\)\.withApiClient,/s);

  for (const path of [
    'mcp/project.advance.js',
    'mcp/project.define.js',
    'mcp/project.amend.js',
    'mcp/production.promote.js',
    'mcp/production.reconcile.js',
    'mcp/release.publish.js',
  ]) {
    assert.match(await readFile(join(root, path), 'utf8'), /githubAppAuth\.withApiClient/, `${path} must forward the bound GitHub auth provider`);
  }
});