import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

const TARGET_REPO = 'laurajoyhutchins/portfolio-control-plane-mirror';
const TARGET_PREFIX = `/repos/${TARGET_REPO}`;
const INITIAL_TEMPLATE_SEED_SHA = 'b7932ad95e035f49c1e2f666e6e53657d48e69fc';
const SHA = '[0-9a-fA-F]{40}';
const TAG = 'hatchable-v[1-9][0-9]*';

function requestError(message, details = {}) {
  return { ok: false, error: 'SOURCE_MIRROR_GITHUB_REQUEST_INVALID', message, may_have_mutated: false, details };
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return requestError('request must be an object');
  const unknown = Object.keys(input).filter((key) => !['path', 'method', 'body'].includes(key));
  if (unknown.length) return requestError('request contains unsupported fields', { unknown: unknown.sort() });
  const method = String(input.method || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH'].includes(method)) return requestError('method is not allowed', { method });
  const rawPath = String(input.path || '');
  if (!rawPath.startsWith(TARGET_PREFIX)) return requestError('path is outside the fixed mirror repository', { path: rawPath });
  const [path, queryText = ''] = rawPath.split('?', 2);
  const query = {};
  if (queryText) {
    const params = new URLSearchParams(queryText);
    for (const [key, value] of params.entries()) query[key] = value;
  }
  const rel = path.slice(TARGET_PREFIX.length);
  const allowed =
    (method === 'GET' && rel === '') ||
    (method === 'GET' && /^\/git\/ref\/heads\/(main|hatchable-ledger)$/.test(rel)) ||
    (method === 'GET' && new RegExp(`^/git/ref/tags/${TAG}$`).test(rel)) ||
    (method === 'GET' && new RegExp(`^/git/blobs/${SHA}$`).test(rel)) ||
    (method === 'GET' && new RegExp(`^/git/trees/${SHA}$`).test(rel) && (Object.keys(query).length === 0 || (query.recursive === '1' && Object.keys(query).length === 1))) ||
    (method === 'GET' && new RegExp(`^/git/commits/${SHA}$`).test(rel)) ||
    (method === 'POST' && rel === '/git/blobs') ||
    (method === 'POST' && rel === '/git/trees') ||
    (method === 'POST' && rel === '/git/commits') ||
    (method === 'POST' && rel === '/git/refs') ||
    (method === 'PATCH' && /^\/git\/refs\/heads\/(main|hatchable-ledger)$/.test(rel));
  if (!allowed) return requestError('GitHub operation is outside the source-mirror allowlist', { method, path: rawPath });

  const body = input.body == null ? undefined : input.body;
  if (method === 'GET' && body !== undefined) return requestError('GET requests cannot include a body');
  if (method !== 'GET' && (!body || typeof body !== 'object' || Array.isArray(body))) return requestError('write requests require an object body');

  if (method === 'POST' && rel === '/git/refs') {
    const ref = String(body.ref || '');
    if (!/^refs\/heads\/hatchable-ledger$/.test(ref) && !new RegExp(`^refs/tags/${TAG}$`).test(ref)) return requestError('ref creation is restricted to the ledger branch and Hatchable version tags', { ref });
    if (!new RegExp(`^${SHA}$`).test(String(body.sha || ''))) return requestError('ref creation requires an exact commit SHA');
  }
  if (method === 'PATCH') {
    if (!new RegExp(`^${SHA}$`).test(String(body.sha || ''))) return requestError('branch update requires an exact commit SHA');
    const force = body.force === true;
    if (force && rel !== '/git/refs/heads/main') return requestError('force updates are allowed only for the one-time main bootstrap replacement');
    if (body.force != null && typeof body.force !== 'boolean') return requestError('force must be boolean');
  }
  return { ok: true, method, path, query, body, rel };
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const blocked = new Set(['token', 'access_token', 'refresh_token', 'temp_clone_token', 'private_key', 'private_key_value']);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !blocked.has(String(key).toLowerCase())).map(([key, item]) => [key, sanitize(item)]));
}

async function callGitHub(normalized, options = {}) {
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  return withApp(TARGET_REPO, async (client) => {
    if (normalized.method === 'PATCH' && normalized.body?.force === true) {
      const observed = await client.call('github', { path: `${TARGET_PREFIX}/git/ref/heads/main`, method: 'GET' });
      const actual = String(observed?.body?.object?.sha || '');
      if (observed?.status !== 200 || actual !== INITIAL_TEMPLATE_SEED_SHA) {
        return { ok: false, error: 'SOURCE_MIRROR_BOOTSTRAP_DRIFT', message: 'Refusing forced main update because the mirror bootstrap predecessor is not the recorded template seed.', upstream_status: Number(observed?.status || 0) || undefined, actual_head: actual || null, expected_head: INITIAL_TEMPLATE_SEED_SHA, may_have_mutated: false };
      }
    }
    const response = await client.call('github', {
      path: normalized.path,
      method: normalized.method,
      body: normalized.body,
      query: Object.keys(normalized.query).length ? normalized.query : undefined,
    });
    return { ok: true, upstream_status: Number(response?.status || 0), body: sanitize(response?.body ?? null), request_id: response?.headers?.['x-github-request-id'] || null };
  }, { permissionProfile: 'changeset' });
}

export async function sourceMirrorGitHubTransport(input, options = {}) {
  const normalized = normalize(input);
  if (!normalized.ok) return normalized;
  try {
    return await callGitHub(normalized, options);
  } catch (error) {
    return { ok: false, error: error?.code || 'SOURCE_MIRROR_GITHUB_TRANSPORT_ERROR', message: String(error?.message || error), upstream_status: Number(error?.status || 0) || undefined, may_have_mutated: normalized.method !== 'GET' };
  }
}

export async function runSourceMirrorGitHubTransportTests() {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); } }
  await test('rejects other repositories', async () => check(!normalize({ path: '/repos/laurajoyhutchins/STE-Lint', method: 'GET' }).ok, 'other repository accepted'));
  await test('rejects arbitrary refs', async () => check(!normalize({ path: `${TARGET_PREFIX}/git/refs`, method: 'POST', body: { ref: 'refs/heads/evil', sha: 'a'.repeat(40) } }).ok, 'arbitrary ref accepted'));
  await test('accepts Hatchable tags and ledger branch', async () => {
    check(normalize({ path: `${TARGET_PREFIX}/git/refs`, method: 'POST', body: { ref: 'refs/tags/hatchable-v130', sha: 'a'.repeat(40) } }).ok, 'version tag rejected');
    check(normalize({ path: `${TARGET_PREFIX}/git/refs`, method: 'POST', body: { ref: 'refs/heads/hatchable-ledger', sha: 'a'.repeat(40) } }).ok, 'ledger branch rejected');
  });
  await test('force update requires recorded template seed', async () => {
    const fake = async (_repo, callback) => callback({ call: async () => ({ status: 200, body: { object: { sha: 'c'.repeat(40) } }, headers: {} }) });
    const result = await sourceMirrorGitHubTransport({ path: `${TARGET_PREFIX}/git/refs/heads/main`, method: 'PATCH', body: { sha: 'a'.repeat(40), force: true } }, { withGitHubAppApiClient: fake });
    check(!result.ok && result.error === 'SOURCE_MIRROR_BOOTSTRAP_DRIFT' && result.may_have_mutated === false, 'unexpected seed did not fail closed');
  });
  await test('credential-like GitHub response fields never cross the transport', async () => {
    const fake = async (_repo, callback) => callback({ call: async () => ({ status: 200, body: { id: 1, temp_clone_token: 'secret', nested: { token: 'secret', safe: true } }, headers: {} }) });
    const result = await sourceMirrorGitHubTransport({ path: TARGET_PREFIX, method: 'GET' }, { withGitHubAppApiClient: fake });
    check(result.ok && result.body?.id === 1 && result.body?.nested?.safe === true, 'safe GitHub fields were lost');
    check(!Object.prototype.hasOwnProperty.call(result.body || {}, 'temp_clone_token') && !Object.prototype.hasOwnProperty.call(result.body?.nested || {}, 'token'), 'credential-like field escaped sanitization');
  });
  const failed = results.filter((item) => !item.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}