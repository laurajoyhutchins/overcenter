import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { withGitHubUserApiClient } from 'lib/github-user-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';
import { consumeRepositoryCreationApproval, ensureRepositoryCreationApproval } from 'lib/github-repository-approval.js';

const OWNER = 'laurajoyhutchins';
const NAME = /^[A-Za-z0-9._-]+$/;

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'REQUEST_INVALID', message: 'request must be an object' };
  const allowed = new Set(['name', 'description']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) return { ok: false, error: 'REQUEST_INVALID', message: 'request contains unsupported fields', unknown };
  const name = String(input.name || '').trim();
  if (!name || name.length > 100 || !NAME.test(name) || name === '.' || name === '..') return { ok: false, error: 'REQUEST_INVALID', message: 'name must be a safe GitHub repository name of at most 100 characters', field: 'name' };
  const description = input.description == null || input.description === '' ? null : String(input.description).trim();
  if (description && description.length > 350) return { ok: false, error: 'REQUEST_INVALID', message: 'description must be at most 350 characters', field: 'description' };
  return { ok: true, name, description, repo: `${OWNER}/${name}` };
}

function approvalRequired(normalized, approval) {
  return {
    ok: false,
    error: 'GITHUB_REPOSITORY_APPROVAL_REQUIRED',
    message: `Manual owner approval is required before creating ${normalized.repo}.`,
    repo: normalized.repo,
    approval_id: approval?.approval_id || null,
    approval_state: approval?.state || 'pending',
    approval_path: approval?.approval_path || '/github-repository-approvals',
    approval_expires_at: approval?.expires_at || null,
    may_have_mutated: false,
  };
}

function repoMatches(body, normalized) {
  const owner = String(body?.owner?.login || '').toLowerCase();
  const fullName = String(body?.full_name || '').toLowerCase();
  if (owner !== OWNER.toLowerCase() || fullName !== normalized.repo.toLowerCase()) return { ok: false, reason: 'owner_or_identity' };
  if (body?.private !== true) return { ok: false, reason: 'visibility' };
  if (normalized.description !== null && String(body?.description || '') !== normalized.description) return { ok: false, reason: 'description' };
  return { ok: true };
}

async function readRepo(apiClient, normalized, phase, options = {}) {
  const path = `/repos/${encodeURIComponent(OWNER)}/${encodeURIComponent(normalized.name)}`;
  let retried;
  try {
    retried = await boundedSafeRead(() => apiClient.call('github', { path, method: 'GET' }), { sleep: options.sleep, random: options.random, maxAttempts: 3 });
  } catch (error) {
    return { ok: false, error: 'GITHUB_UPSTREAM_ERROR', message: String(error?.message || 'GitHub repository read failed.'), phase, github_path: path, attempts: Number(error?.githubTransportAttempts || 1), may_have_mutated: false };
  }
  const response = retried.response;
  if (response?.status === 404) return { ok: true, found: false, evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }) };
  if (!response || response.status < 200 || response.status >= 300) {
    const status = Number(response?.status || 0);
    return { ok: false, error: status === 401 || status === 403 ? 'GITHUB_PERMISSION_DENIED' : 'GITHUB_UPSTREAM_ERROR', message: String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`), upstream_status: status || undefined, ...githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }) };
  }
  return { ok: true, found: true, body: response.body, evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }) };
}

async function installationProbe(repo) {
  try {
    await withGitHubAppApiClient(repo, async () => ({ ok: true }), { permissionProfile: 'changeset' });
    return { state: 'available', installation_access: true };
  } catch (error) {
    if (error?.code === 'GITHUB_APP_INSTALLATION_NOT_FOUND' || Number(error?.status) === 404) return { state: 'not_installed', installation_access: false };
    return { state: 'unknown', installation_access: null, installation_error: error?.code || 'GITHUB_APP_AUTH_ERROR' };
  }
}

function successView(body, normalized, extras = {}) {
  return {
    ok: true,
    repo: normalized.repo,
    repository_id: Number(body?.id || 0) || null,
    private: body?.private === true,
    html_url: body?.html_url || null,
    default_branch: body?.default_branch || null,
    ...extras,
  };
}

async function createWithClient(normalized, apiClient, options = {}) {
  const existing = await readRepo(apiClient, normalized, 'inspect.repository', options);
  if (!existing.ok) return existing;
  if (existing.found) {
    const match = repoMatches(existing.body, normalized);
    if (!match.ok) return { ok: false, error: 'GITHUB_REPOSITORY_CONFLICT', message: 'A repository with this name already exists but does not match the requested private repository identity.', repo: normalized.repo, conflict: match.reason, may_have_mutated: false };
    const install = await (options.installationProbe || installationProbe)(normalized.repo);
    return successView(existing.body, normalized, { outcome: 'already_exists', created: false, changed: false, verified: true, ...install, github_evidence: [existing.evidence] });
  }

  const path = '/user/repos';
  const body = { name: normalized.name, private: true, auto_init: false };
  if (normalized.description !== null) body.description = normalized.description;
  let response = null;
  let transportError = null;
  try { response = await apiClient.call('github', { path, method: 'POST', body }); }
  catch (error) { transportError = error; }

  if (response?.status === 201) {
    const match = repoMatches(response.body, normalized);
    if (!match.ok) return { ok: false, error: 'GITHUB_REPOSITORY_CREATE_INDETERMINATE', message: 'GitHub reported repository creation but the returned repository identity did not match the request.', repo: normalized.repo, conflict: match.reason, may_have_mutated: true };
    const verified = await readRepo(apiClient, normalized, 'verify.repository', options);
    const evidence = [githubTransportEvidence(response, { phase: 'mutate.create', path, attempts: 1, mayHaveMutated: true })];
    if (verified.ok && verified.found) {
      evidence.push(verified.evidence);
      const verifiedMatch = repoMatches(verified.body, normalized);
      if (!verifiedMatch.ok) return { ok: false, error: 'GITHUB_REPOSITORY_CREATE_INDETERMINATE', message: 'Repository creation readback did not match the requested identity.', repo: normalized.repo, conflict: verifiedMatch.reason, may_have_mutated: true, github_evidence: evidence };
      const install = await (options.installationProbe || installationProbe)(normalized.repo);
      return successView(verified.body, normalized, { outcome: 'created', created: true, changed: true, verified: true, empty_on_creation: Number(response.body?.size || 0) === 0, ...install, github_evidence: evidence });
    }
    const install = await (options.installationProbe || installationProbe)(normalized.repo);
    if (install.installation_access === false) {
      return successView(response.body, normalized, { outcome: 'created_requires_installation_access', created: true, changed: true, verified: true, empty_on_creation: Number(response.body?.size || 0) === 0, ...install, github_evidence: evidence });
    }
    return { ok: false, error: 'GITHUB_REPOSITORY_CREATE_INDETERMINATE', message: 'GitHub created the repository but authoritative readback could not be completed.', repo: normalized.repo, may_have_mutated: true, github_evidence: evidence };
  }

  const status = Number(response?.status || transportError?.status || 0);
  const reconciled = await readRepo(apiClient, normalized, 'reconcile.repository', options);
  if (reconciled.ok && reconciled.found) {
    const match = repoMatches(reconciled.body, normalized);
    if (match.ok) {
      const install = await (options.installationProbe || installationProbe)(normalized.repo);
      return successView(reconciled.body, normalized, { outcome: 'reconciled_after_create', created: null, changed: true, verified: true, ...install, github_evidence: [reconciled.evidence] });
    }
    return { ok: false, error: 'GITHUB_REPOSITORY_CONFLICT', message: 'Repository creation raced with an incompatible existing repository.', repo: normalized.repo, conflict: match.reason, may_have_mutated: Boolean(transportError || response) };
  }
  if (status === 401 || status === 403) return { ok: false, error: 'GITHUB_PERMISSION_DENIED', message: String(response?.body?.message || transportError?.message || 'GitHub denied repository creation.'), upstream_status: status, may_have_mutated: false };
  if (status === 422 && !transportError) return { ok: false, error: 'GITHUB_REPOSITORY_CONFLICT', message: String(response?.body?.message || 'GitHub rejected repository creation.'), repo: normalized.repo, upstream_status: status, may_have_mutated: false };
  return { ok: false, error: 'GITHUB_REPOSITORY_CREATE_INDETERMINATE', message: String(transportError?.message || response?.body?.message || 'Repository creation outcome could not be determined.'), repo: normalized.repo, upstream_status: status || undefined, may_have_mutated: true };
}

async function resolveApproval(normalized, options) {
  if (options.approval) return options.approval;
  return ensureRepositoryCreationApproval(normalized, {
    store: options.approvalStore,
    db: options.db,
    now: options.now,
    ttlMs: options.approvalTtlMs,
  });
}

async function finalizeApprovedResult(result, approval, options) {
  if (!result?.ok) return { ...result, approval_id: approval.approval_id || null, approval_state: approval.state || 'approved' };
  const consumed = options.skipApprovalConsume
    ? { approval_id: approval.approval_id, state: 'consumed' }
    : await consumeRepositoryCreationApproval(approval, { store: options.approvalStore, db: options.db, now: options.now, ttlMs: options.approvalTtlMs });
  return {
    ...result,
    approval_id: approval.approval_id || null,
    approval_state: consumed?.state || 'approved',
    approval_consumed: Boolean(consumed),
  };
}

export async function createGithubRepository(input, options = {}) {
  const normalized = normalize(input);
  if (!normalized.ok) return normalized;

  let approval;
  try { approval = await resolveApproval(normalized, options); }
  catch (error) {
    return { ok: false, error: 'GITHUB_REPOSITORY_APPROVAL_ERROR', message: String(error?.message || error), repo: normalized.repo, may_have_mutated: false };
  }
  if (!approval?.approved) return approvalRequired(normalized, approval);

  try {
    const result = options.apiClient
      ? await createWithClient(normalized, options.apiClient, options)
      : await withGitHubUserApiClient((apiClient) => createWithClient(normalized, apiClient, options), options);
    return finalizeApprovedResult(result, approval, options);
  } catch (error) {
    const code = error?.code || 'GITHUB_USER_AUTH_ERROR';
    return { ok: false, error: code, message: String(error?.message || error), ...(error?.status ? { upstream_status: Number(error.status) } : {}), repo: normalized.repo, approval_id: approval.approval_id || null, approval_state: approval.state || 'approved', may_have_mutated: false };
  }
}

export async function runGithubRepositoryCreateRegressionTests() {
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); } }
  const repoBody = (overrides = {}) => ({ id: 42, full_name: `${OWNER}/fixture`, owner: { login: OWNER }, private: true, description: 'fixture', size: 0, html_url: `https://github.com/${OWNER}/fixture`, ...overrides });
  const probe = async () => ({ state: 'available', installation_access: true });
  const approved = { approved: true, state: 'approved', approval_id: '00000000-0000-0000-0000-000000000001', request_sha256: 'fixture-sha' };
  const baseOptions = { approval: approved, skipApprovalConsume: true, installationProbe: probe, sleep: async () => {} };

  await test('request surface rejects caller-supplied owner or visibility', async () => {
    check(normalize({ name: 'fixture', owner: 'someone-else' }).ok === false, 'owner override was accepted');
    check(normalize({ name: 'fixture', visibility: 'public' }).ok === false, 'visibility override was accepted');
  });
  await test('pending approval blocks all GitHub calls', async () => {
    let calls = 0;
    const api = { call: async () => { calls += 1; return { status: 500, body: {}, headers: {} }; } };
    const result = await createGithubRepository({ name: 'fixture', description: 'fixture' }, {
      apiClient: api,
      approval: { approved: false, state: 'pending', approval_id: '00000000-0000-0000-0000-000000000002', approval_path: '/github-repository-approvals', expires_at: '2099-01-01T00:00:00Z' },
    });
    check(!result.ok && result.error === 'GITHUB_REPOSITORY_APPROVAL_REQUIRED' && calls === 0 && result.may_have_mutated === false, 'pending approval did not hard-stop before GitHub');
  });
  await test('existing matching private repository is idempotent after approval', async () => {
    const api = { call: async () => ({ status: 200, body: repoBody(), headers: {} }) };
    const result = await createGithubRepository({ name: 'fixture', description: 'fixture' }, { ...baseOptions, apiClient: api });
    check(result.ok && result.outcome === 'already_exists' && result.created === false, 'existing repo did not converge');
  });
  await test('existing public repository fails closed', async () => {
    const api = { call: async () => ({ status: 200, body: repoBody({ private: false }), headers: {} }) };
    const result = await createGithubRepository({ name: 'fixture', description: 'fixture' }, { ...baseOptions, apiClient: api });
    check(!result.ok && result.error === 'GITHUB_REPOSITORY_CONFLICT', 'public conflict was not rejected');
  });
  await test('successful create is verified by readback', async () => {
    let calls = 0;
    const api = { call: async (_name, request) => {
      calls += 1;
      if (request.method === 'POST') return { status: 201, body: repoBody(), headers: {} };
      if (calls === 1) return { status: 404, body: { message: 'Not Found' }, headers: {} };
      return { status: 200, body: repoBody(), headers: {} };
    } };
    const result = await createGithubRepository({ name: 'fixture', description: 'fixture' }, { ...baseOptions, apiClient: api });
    check(result.ok && result.outcome === 'created' && result.verified === true, 'create was not verified');
  });
  await test('successful create consumes exact approval', async () => {
    let consumed = 0;
    const store = { consume: async (id, sha) => { check(id === approved.approval_id && sha === approved.request_sha256, 'wrong approval consumed'); consumed += 1; return { approval_id: id, state: 'consumed' }; } };
    const api = { call: async () => ({ status: 200, body: repoBody(), headers: {} }) };
    const result = await createGithubRepository({ name: 'fixture', description: 'fixture' }, { approval: approved, approvalStore: store, apiClient: api, installationProbe: probe, sleep: async () => {} });
    check(result.ok && consumed === 1 && result.approval_consumed === true && result.approval_state === 'consumed', 'approval was not consumed exactly once');
  });
  await test('transport loss after create reconciles to matching repository', async () => {
    let reads = 0;
    const api = { call: async (_name, request) => {
      if (request.method === 'POST') throw new Error('connection lost');
      reads += 1;
      return reads === 1 ? { status: 404, body: {}, headers: {} } : { status: 200, body: repoBody(), headers: {} };
    } };
    const result = await createGithubRepository({ name: 'fixture', description: 'fixture' }, { ...baseOptions, apiClient: api });
    check(result.ok && result.outcome === 'reconciled_after_create', 'indeterminate create did not reconcile');
  });
  await test('unresolved transport loss remains indeterminate without consuming approval', async () => {
    const api = { call: async (_name, request) => request.method === 'POST' ? Promise.reject(new Error('connection lost')) : ({ status: 404, body: {}, headers: {} }) };
    const result = await createGithubRepository({ name: 'fixture', description: 'fixture' }, { ...baseOptions, apiClient: api });
    check(!result.ok && result.error === 'GITHUB_REPOSITORY_CREATE_INDETERMINATE' && result.may_have_mutated === true && result.approval_state === 'approved', 'unresolved create did not preserve approved state for reconciliation');
  });

  const failed = results.filter((item) => !item.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}