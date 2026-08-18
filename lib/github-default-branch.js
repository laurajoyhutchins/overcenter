import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const SHA40 = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*[~^:?*\[\\\s])[^/]+(?:\/[^/]+)*$/;

class GitHubDefaultBranchError extends Error {
  constructor(code, message, details = null, httpStatus = null) {
    super(message);
    this.name = 'GitHubDefaultBranchError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = null) {
  throw new GitHubDefaultBranchError(code, message, details, httpStatus);
}

function normalizeBranch(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail('INVALID_BRANCH', `${field} must be a non-empty branch name`, { field }, 422);
  const branch = value.trim();
  if (!SAFE_BRANCH.test(branch) || branch.startsWith('refs/') || branch.endsWith('/') || branch.endsWith('.') || branch.includes('//')) {
    fail('INVALID_BRANCH', `${field} is not a safe branch name`, { field, branch }, 422);
  }
  return branch;
}

export function normalizeDefaultBranchMigrationRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', 'request must be an object', null, 422);
  const allowed = new Set(['repo', 'from', 'to', 'expected_head']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', 'request contains unknown fields', { unknown }, 422);
  const repo = String(input.repo || '').trim();
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be owner/repo', { repo }, 422);
  const from = normalizeBranch(input.from, 'from');
  const to = normalizeBranch(input.to, 'to');
  if (from === to) fail('INVALID_REQUEST', 'from and to branches must differ', { from, to }, 422);
  const expectedHead = String(input.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(expectedHead)) fail('INVALID_SHA', 'expected_head must be a full 40-character hexadecimal SHA', null, 422);
  return { repo, from, to, expected_head: expectedHead };
}

function encodePath(value) { return encodeURIComponent(String(value)); }

async function read(apiClient, path, phase, options = {}, allow404 = false) {
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.call('github', { path, method: 'GET' }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
  } catch (error) {
    return { ok: false, error: 'GITHUB_UPSTREAM_ERROR', message: String(error?.message || 'GitHub read failed.'), phase, github_path: path, attempts: Number(error?.githubTransportAttempts || 1), may_have_mutated: false };
  }
  const response = retried.response;
  if (allow404 && Number(response?.status) === 404) {
    return { ok: true, found: false, body: null, evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }) };
  }
  if (!response || response.status < 200 || response.status >= 300) {
    const status = Number(response?.status || 0);
    return { ok: false, error: status === 401 || status === 403 ? 'GITHUB_PERMISSION_DENIED' : (status === 404 ? 'GITHUB_NOT_FOUND' : 'GITHUB_UPSTREAM_ERROR'), message: String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`), ...(status ? { upstream_status: status } : {}), ...githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }) };
  }
  return { ok: true, found: true, body: response.body, evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }) };
}

async function write(apiClient, path, method, body, phase) {
  let response;
  try { response = await apiClient.call('github', { path, method, body }); }
  catch (error) {
    return { ok: false, error: 'GITHUB_DEFAULT_BRANCH_INDETERMINATE', message: String(error?.message || 'GitHub mutation transport failed.'), phase, github_path: path, may_have_mutated: true };
  }
  if (!response || response.status < 200 || response.status >= 300) {
    const status = Number(response?.status || 0);
    return { ok: false, error: status === 401 || status === 403 ? 'GITHUB_PERMISSION_DENIED' : 'GITHUB_UPSTREAM_ERROR', message: String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`), ...(status ? { upstream_status: status } : {}), ...githubTransportEvidence(response, { phase, path, attempts: 1, mayHaveMutated: true }) };
  }
  return { ok: true, body: response.body, evidence: githubTransportEvidence(response, { phase, path, attempts: 1, mayHaveMutated: true }) };
}

async function readRepo(apiClient, normalized, options, phase) {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}`;
  const result = await read(apiClient, path, phase, options);
  if (!result.ok) return result;
  return { ok: true, default_branch: String(result.body?.default_branch || ''), path, evidence: result.evidence };
}

async function readBranch(apiClient, normalized, branch, options, phase, allow404 = false) {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodePath(owner)}/${encodePath(repo)}/branches/${encodePath(branch)}`;
  const result = await read(apiClient, path, phase, options, allow404);
  if (!result.ok || result.found === false) return result;
  const sha = String(result.body?.commit?.sha || '').toLowerCase();
  if (!SHA40.test(sha)) return { ok: false, error: 'GITHUB_INVALID_RESPONSE', message: 'GitHub returned a branch without a valid head SHA.', phase, github_path: path };
  return { ok: true, found: true, sha, path, evidence: result.evidence };
}

async function reconcileAfterDefaultWrite(apiClient, normalized, options, evidence) {
  const repo = await readRepo(apiClient, normalized, options, 'verify.repository');
  if (!repo.ok) return repo;
  evidence.push(repo.evidence);
  const target = await readBranch(apiClient, normalized, normalized.to, options, 'verify.target');
  if (!target.ok) return target;
  evidence.push(target.evidence);
  if (repo.default_branch !== normalized.to || target.sha !== normalized.expected_head) {
    return { ok: false, error: 'GITHUB_DEFAULT_BRANCH_INDETERMINATE', message: 'Default-branch migration readback does not match the intended target.', repo: normalized.repo, from: normalized.from, to: normalized.to, expected_head: normalized.expected_head, observed_default_branch: repo.default_branch, observed_target_head: target.sha, phase: 'verify', may_have_mutated: true, github_evidence: evidence };
  }
  return { ok: true, outcome: 'migrated', repo: normalized.repo, from: normalized.from, to: normalized.to, expected_head: normalized.expected_head, observed_head: target.sha, old_branch_retained: true, changed: true, verified: true, github_evidence: evidence };
}

async function migrateNormalized(normalized, apiClient, options = {}) {
  const evidence = [];
  const repo = await readRepo(apiClient, normalized, options, 'inspect.repository');
  if (!repo.ok) return repo;
  evidence.push(repo.evidence);

  if (repo.default_branch === normalized.to) {
    const target = await readBranch(apiClient, normalized, normalized.to, options, 'inspect.target');
    if (!target.ok) return target;
    evidence.push(target.evidence);
    if (target.sha !== normalized.expected_head) return { ok: false, error: 'HEAD_MISMATCH', message: 'The target default branch does not match expected_head.', repo: normalized.repo, branch: normalized.to, expected_head: normalized.expected_head, actual_head: target.sha, phase: 'inspect.target' };
    return { ok: true, outcome: 'already_migrated', repo: normalized.repo, from: normalized.from, to: normalized.to, expected_head: normalized.expected_head, observed_head: target.sha, old_branch_retained: true, changed: false, verified: true, github_evidence: evidence };
  }
  if (repo.default_branch !== normalized.from) return { ok: false, error: 'GITHUB_DEFAULT_BRANCH_CONFLICT', message: 'Repository default branch is neither the expected source nor target branch.', repo: normalized.repo, expected_from: normalized.from, intended_to: normalized.to, actual_default_branch: repo.default_branch, phase: 'inspect.repository' };

  const source = await readBranch(apiClient, normalized, normalized.from, options, 'inspect.source');
  if (!source.ok) return source;
  evidence.push(source.evidence);
  if (source.sha !== normalized.expected_head) return { ok: false, error: 'HEAD_MISMATCH', message: 'Source default branch moved.', repo: normalized.repo, branch: normalized.from, expected_head: normalized.expected_head, actual_head: source.sha, phase: 'inspect.source' };

  let target = await readBranch(apiClient, normalized, normalized.to, options, 'inspect.target', true);
  if (!target.ok) return target;
  evidence.push(target.evidence);
  if (target.found && target.sha !== normalized.expected_head) return { ok: false, error: 'GITHUB_DEFAULT_BRANCH_CONFLICT', message: 'Target branch already exists at a different commit.', repo: normalized.repo, branch: normalized.to, expected_head: normalized.expected_head, actual_head: target.sha, phase: 'inspect.target' };

  const preRepo = await readRepo(apiClient, normalized, options, 'precondition.repository');
  if (!preRepo.ok) return preRepo;
  evidence.push(preRepo.evidence);
  const preSource = await readBranch(apiClient, normalized, normalized.from, options, 'precondition.source');
  if (!preSource.ok) return preSource;
  evidence.push(preSource.evidence);
  if (preRepo.default_branch !== normalized.from || preSource.sha !== normalized.expected_head) return { ok: false, error: 'GITHUB_DEFAULT_BRANCH_CHANGED', message: 'Repository default-branch state changed before mutation.', repo: normalized.repo, from: normalized.from, to: normalized.to, expected_head: normalized.expected_head, actual_default_branch: preRepo.default_branch, actual_head: preSource.sha, phase: 'precondition' };

  const [owner, repoName] = normalized.repo.split('/');
  if (!target.found) {
    const createPath = `/repos/${encodePath(owner)}/${encodePath(repoName)}/git/refs`;
    const created = await write(apiClient, createPath, 'POST', { ref: `refs/heads/${normalized.to}`, sha: normalized.expected_head }, 'mutate.create_target');
    if (!created.ok) {
      const reconcile = await readBranch(apiClient, normalized, normalized.to, options, 'reconcile.target', true);
      if (!reconcile.ok || !reconcile.found || reconcile.sha !== normalized.expected_head) return { ...created, error: 'GITHUB_DEFAULT_BRANCH_INDETERMINATE', message: 'Target branch creation did not complete deterministically.', may_have_mutated: true };
      evidence.push(reconcile.evidence);
    } else evidence.push(created.evidence);
  }

  const updatePath = `/repos/${encodePath(owner)}/${encodePath(repoName)}`;
  const updated = await write(apiClient, updatePath, 'PATCH', { default_branch: normalized.to }, 'mutate.default_branch');
  if (!updated.ok) {
    const reconciled = await reconcileAfterDefaultWrite(apiClient, normalized, options, evidence);
    if (reconciled.ok) return reconciled;
    return { ...updated, error: 'GITHUB_DEFAULT_BRANCH_INDETERMINATE', message: 'Default-branch update outcome is indeterminate; the target branch may have been created and the repository default may have changed.', may_have_mutated: true, github_evidence: evidence };
  }
  evidence.push(updated.evidence);
  return reconcileAfterDefaultWrite(apiClient, normalized, options, evidence);
}

function errorResult(error) {
  if (error instanceof GitHubDefaultBranchError) return { ok: false, error: error.code, message: error.message, ...(error.details || {}), ...(error.httpStatus ? { status: error.httpStatus } : {}) };
  return { ok: false, error: error?.code || 'INTERNAL_ERROR', message: String(error?.message || error || 'Unexpected default-branch migration failure.') };
}

export async function migrateGithubDefaultBranchWithGitHubApp(input, options = {}) {
  let normalized;
  try { normalized = normalizeDefaultBranchMigrationRequest(input); }
  catch (error) { return errorResult(error); }
  try {
    return await withGitHubAppApiClient(normalized.repo, async (apiClient) => migrateNormalized(normalized, apiClient, options), { permissionProfile: 'default_branch_migrate' });
  } catch (error) {
    const message = String(error?.message || 'GitHub App authentication failed.');
    const denied = [401, 403, 422].includes(Number(error?.status)) && /permission|access|granted/i.test(message);
    if (denied) return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message, upstream_status: Number(error.status), required_permissions: { administration: 'write', contents: 'write' } };
    return { ok: false, error: error?.code || 'GITHUB_APP_AUTH_ERROR', message, ...(error?.status ? { upstream_status: Number(error.status) } : {}) };
  }
}