import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function fail(code, message, details = null, httpStatus = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.httpStatus = httpStatus;
  throw error;
}

function exactFields(value, allowed, name) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', `${name} contains unsupported fields`, { field: name, unknown }, 422);
}

function validateRepo(value) {
  const repo = String(value || '').trim();
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be in owner/repo form', { repo }, 422);
  return repo;
}

function validateNewName(value) {
  const name = String(value || '').trim();
  if (!REPOSITORY_NAME.test(name) || name === '.' || name === '..') {
    fail('INVALID_REPOSITORY_NAME', 'new_name must be a valid GitHub repository name', { new_name: name }, 422);
  }
  return name;
}

function validateRepositoryId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    fail('INVALID_REPOSITORY_ID', 'expected_repository_id must be a positive integer', { expected_repository_id: value }, 422);
  }
  return id;
}

export function normalizeGithubRepositoryRenameRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', 'request must be an object', null, 422);
  exactFields(input, new Set(['repo', 'new_name', 'expected_repository_id']), 'request');
  const repo = validateRepo(input.repo);
  const [owner, currentName] = repo.split('/');
  const newName = validateNewName(input.new_name);
  if (newName === currentName) fail('INVALID_REPOSITORY_NAME', 'new_name must differ from the current repository name', { new_name: newName }, 422);
  return {
    repo,
    new_name: newName,
    new_repo: `${owner}/${newName}`,
    expected_repository_id: validateRepositoryId(input.expected_repository_id),
  };
}

function repoPath(repo) {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function sameCoordinate(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function observedRepositoryId(body) {
  const id = Number(body?.id || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function transportFailure(response, phase, path, mayHaveMutated = false) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const evidence = githubTransportEvidence(response, { phase, path, attempts: 1, mayHaveMutated });
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: 'GITHUB_APP_PERMISSION_DENIED',
      message,
      upstream_status: status,
      required_permissions: { administration: 'write', metadata: 'read' },
      ...evidence,
    };
  }
  if (status === 404) return { ok: false, error: 'GITHUB_NOT_FOUND', message, upstream_status: status, ...evidence };
  return {
    ok: false,
    error: 'GITHUB_UPSTREAM_ERROR',
    message,
    ...(status ? { upstream_status: status } : {}),
    ...evidence,
  };
}

async function safeRead(apiClient, repo, options, phase) {
  const path = repoPath(repo);
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.call('github', { method: 'GET', path }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
  } catch (error) {
    return {
      ok: false,
      error: 'GITHUB_UPSTREAM_ERROR',
      message: String(error?.message || 'GitHub repository read failed.'),
      phase,
      github_path: path,
      attempts: Number(error?.githubTransportAttempts || 1),
      may_have_mutated: false,
    };
  }
  const response = retried.response;
  if (!response || response.status < 200 || response.status >= 300) {
    const failure = transportFailure(response, phase, path, false);
    failure.github_path = path;
    failure.attempts = retried.attempts;
    return failure;
  }
  return {
    ok: true,
    body: response.body || {},
    evidence: githubTransportEvidence(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false }),
  };
}

function identityChanged(normalized, observed, phase = 'precondition') {
  return {
    ok: false,
    error: 'GITHUB_REPOSITORY_IDENTITY_CHANGED',
    message: 'Observed repository identity does not match the expected immutable GitHub repository id and coordinate.',
    repo: normalized.repo,
    new_repo: normalized.new_repo,
    expected_repository_id: normalized.expected_repository_id,
    observed_repository_id: observedRepositoryId(observed),
    observed_full_name: observed?.full_name || null,
    phase,
    may_have_mutated: false,
  };
}

function success(normalized, outcome, changed, evidence = {}) {
  return {
    ok: true,
    outcome,
    repo: normalized.repo,
    new_repo: normalized.new_repo,
    repository_id: normalized.expected_repository_id,
    changed,
    verified: true,
    may_have_mutated: false,
    evidence,
  };
}

function indeterminate(normalized, evidence = {}, details = {}) {
  return {
    ok: false,
    error: 'GITHUB_REPOSITORY_RENAME_INDETERMINATE',
    message: 'Repository rename may have occurred, but the expected immutable repository identity is not verified at the requested new coordinate.',
    repo: normalized.repo,
    new_repo: normalized.new_repo,
    expected_repository_id: normalized.expected_repository_id,
    phase: 'verify',
    may_have_mutated: true,
    evidence,
    ...details,
  };
}

function verifiedAtTarget(normalized, read) {
  return read?.ok === true
    && observedRepositoryId(read.body) === normalized.expected_repository_id
    && sameCoordinate(read.body?.full_name, normalized.new_repo);
}

async function reconcileAfterPossibleWrite(apiClient, normalized, options, evidence = {}) {
  const verified = await safeRead(apiClient, normalized.new_repo, options, 'verify.repository');
  if (verifiedAtTarget(normalized, verified)) {
    return success(normalized, 'reconciled_after_indeterminate_write', true, { ...evidence, verify: verified.evidence });
  }
  if (verified.ok) {
    return indeterminate(normalized, { ...evidence, verify: verified.evidence }, {
      observed_repository_id: observedRepositoryId(verified.body),
      observed_full_name: verified.body?.full_name || null,
    });
  }
  return indeterminate(normalized, evidence, { verification_error: verified.error });
}

export async function renameGithubRepository(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubRepositoryRenameRequest(input);
  } catch (error) {
    return {
      ok: false,
      error: error.code || 'INVALID_REQUEST',
      message: error.message,
      ...(error.details || {}),
      ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
      may_have_mutated: false,
    };
  }

  const apiClient = options.apiClient;
  if (!apiClient) return { ok: false, error: 'GITHUB_TRANSPORT_UNAVAILABLE', message: 'A GitHub API transport is required.', may_have_mutated: false };

  let observed = await safeRead(apiClient, normalized.repo, options, 'inspect.repository');
  if (!observed.ok && observed.error === 'GITHUB_NOT_FOUND') {
    const target = await safeRead(apiClient, normalized.new_repo, options, 'inspect.target_repository');
    if (target.ok) observed = target;
  }
  if (!observed.ok) return observed;

  if (observedRepositoryId(observed.body) !== normalized.expected_repository_id) {
    return identityChanged(normalized, observed.body);
  }
  if (sameCoordinate(observed.body?.full_name, normalized.new_repo)) {
    return success(normalized, 'already_renamed', false, { inspect: observed.evidence });
  }
  if (!sameCoordinate(observed.body?.full_name, normalized.repo)) {
    return identityChanged(normalized, observed.body);
  }

  const path = repoPath(normalized.repo);
  let write;
  try {
    write = await apiClient.call('github', { method: 'PATCH', path, body: { name: normalized.new_name } });
  } catch {
    return reconcileAfterPossibleWrite(apiClient, normalized, options, { inspect: observed.evidence });
  }

  const status = Number(write?.status || 0);
  if (!write || status < 200 || status >= 300) {
    if (status === 0 || status >= 500) {
      return reconcileAfterPossibleWrite(apiClient, normalized, options, { inspect: observed.evidence });
    }
    if (status === 401 || status === 403) return transportFailure(write, 'write.repository', path, false);
    return {
      ok: false,
      error: 'GITHUB_REPOSITORY_RENAME_REJECTED',
      message: String(write?.body?.message || `GitHub rejected repository rename with HTTP ${status}.`),
      repo: normalized.repo,
      new_repo: normalized.new_repo,
      expected_repository_id: normalized.expected_repository_id,
      upstream_status: status || null,
      phase: 'write',
      may_have_mutated: false,
      evidence: { inspect: observed.evidence, write: githubTransportEvidence(write, { phase: 'write.repository', path, attempts: 1, mayHaveMutated: false }) },
    };
  }

  const writeEvidence = githubTransportEvidence(write, { phase: 'write.repository', path, attempts: 1, mayHaveMutated: true });
  const verified = await safeRead(apiClient, normalized.new_repo, options, 'verify.repository');
  if (verifiedAtTarget(normalized, verified)) {
    return success(normalized, 'renamed', true, { inspect: observed.evidence, write: writeEvidence, verify: verified.evidence });
  }
  if (verified.ok) {
    return indeterminate(normalized, { inspect: observed.evidence, write: writeEvidence, verify: verified.evidence }, {
      observed_repository_id: observedRepositoryId(verified.body),
      observed_full_name: verified.body?.full_name || null,
    });
  }
  return indeterminate(normalized, { inspect: observed.evidence, write: writeEvidence }, { verification_error: verified.error });
}

function authFailure(error) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  const status = Number(error?.status || 0);
  if (/config\/get 412|declared as required but not set/i.test(message)) {
    return { ok: false, error: 'GITHUB_APP_SETUP_REQUIRED', message: 'Configure the GitHub App ID and private key before using this command.', may_have_mutated: false };
  }
  if (status === 401 || status === 403 || status === 422) {
    return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message, ...(status ? { upstream_status: status } : {}), may_have_mutated: false };
  }
  if (status === 404) {
    return { ok: false, error: 'GITHUB_APP_INSTALLATION_NOT_FOUND', message, upstream_status: 404, may_have_mutated: false };
  }
  return { ok: false, error: error?.code || 'GITHUB_APP_AUTH_ERROR', message, ...(status ? { upstream_status: status } : {}), may_have_mutated: Boolean(error?.mayHaveMutated) };
}

function oldCoordinateAuthMayHaveMoved(error) {
  const status = Number(error?.status || 0);
  return status === 404 || status === 422 || error?.code === 'GITHUB_APP_INSTALLATION_NOT_FOUND';
}

export async function renameGithubRepositoryWithGitHubApp(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubRepositoryRenameRequest(input);
  } catch (error) {
    return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}), may_have_mutated: false };
  }

  const canonicalInput = {
    repo: normalized.repo,
    new_name: normalized.new_name,
    expected_repository_id: normalized.expected_repository_id,
  };
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  const invoke = (repo) => withApp(
    repo,
    (apiClient) => renameGithubRepository(canonicalInput, { ...options, apiClient }),
    { permissionProfile: 'repository_metadata' },
  );

  try {
    return await invoke(normalized.repo);
  } catch (oldCoordinateError) {
    if (!oldCoordinateAuthMayHaveMoved(oldCoordinateError)) return authFailure(oldCoordinateError);
    try {
      return await invoke(normalized.new_repo);
    } catch (newCoordinateError) {
      return authFailure(newCoordinateError);
    }
  }
}
