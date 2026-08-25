import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class GitHubArchiveRepositoryError extends Error {
  constructor(code, message, details = null, httpStatus = null) {
    super(message);
    this.name = 'GitHubArchiveRepositoryError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function fail(code, message, details = null, httpStatus = null) {
  throw new GitHubArchiveRepositoryError(code, message, details, httpStatus);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_REQUEST', `${field} must be an object`, { field }, 422);
  }
  return value;
}

function exactFields(value, allowed, field) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', `${field} contains unknown fields`, { field, unknown }, 422);
}

function validateRepo(value) {
  if (typeof value !== 'string' || !REPO.test(value) || value.length > 256) {
    fail('INVALID_REPOSITORY', 'repo must be owner/repo', { repo: value || null }, 422);
  }
  return value;
}

function validateRepositoryId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    fail('INVALID_GITHUB_REPOSITORY_ID', 'expected_repository_id must be a positive GitHub repository id', { expected_repository_id: value ?? null }, 422);
  }
  return id;
}

export function normalizeGithubArchiveRepositoryRequest(input) {
  const body = object(input, 'request');
  exactFields(body, new Set(['repo', 'expected_repository_id', 'expected_archived']), 'request');
  if (body.expected_archived !== false) {
    fail('INVALID_REQUEST', 'expected_archived must be false for github.archive_repository', { expected_archived: body.expected_archived ?? null }, 422);
  }
  return {
    repo: validateRepo(body.repo),
    expected_repository_id: validateRepositoryId(body.expected_repository_id),
    expected_archived: false,
  };
}

function errorResult(error) {
  if (error instanceof GitHubArchiveRepositoryError) {
    return {
      ok: false,
      error: error.code,
      message: error.message,
      ...(error.details || {}),
      ...(error.httpStatus ? { status: error.httpStatus } : {}),
    };
  }
  return {
    ok: false,
    error: error?.code || 'INTERNAL_ERROR',
    message: String(error?.message || error || 'Unexpected repository archive failure.'),
  };
}

function githubAppErrorResult(error) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  const status = Number(error?.status || 0);
  const evidence = {
    ...(error?.phase ? { phase: error.phase } : {}),
    ...(error?.githubPath ? { github_path: error.githubPath } : {}),
    ...(error?.githubRequestId ? { github_request_id: error.githubRequestId } : {}),
    ...(error?.retryAfter ? { retry_after: error.retryAfter } : {}),
    ...(error?.attempts ? { attempts: Number(error.attempts) } : {}),
    ...(error?.mayHaveMutated !== undefined ? { may_have_mutated: Boolean(error.mayHaveMutated) } : {}),
  };
  if (/config\/get 412|declared as required but not set/i.test(message)) {
    return {
      ok: false,
      error: 'GITHUB_APP_SETUP_REQUIRED',
      message: 'Configure the GitHub App ID and private key in Hatchable Setup before using this command.',
      ...evidence,
    };
  }
  if (['INVALID_REPO', 'INVALID_GITHUB_APP_ID', 'INVALID_GITHUB_APP_PRIVATE_KEY'].includes(error?.code)) {
    return { ok: false, error: error.code, message, ...evidence };
  }
  if (status === 404) {
    return {
      ok: false,
      error: 'GITHUB_APP_INSTALLATION_NOT_FOUND',
      message: 'The GitHub App is not installed for this repository.',
      upstream_status: 404,
      ...evidence,
    };
  }
  if ([401, 403].includes(status) || (status === 422 && /permission|access|granted|not permitted|resource not accessible/i.test(message))) {
    return {
      ok: false,
      error: 'GITHUB_APP_PERMISSION_DENIED',
      message,
      upstream_status: status,
      ...evidence,
    };
  }
  return {
    ok: false,
    error: error?.code || 'GITHUB_APP_AUTH_ERROR',
    message,
    ...(status ? { upstream_status: status } : {}),
    ...evidence,
  };
}

function responseFailure(response, { phase, path, attempts = 1, mayHaveMutated = false } = {}) {
  const status = Number(response?.status || 0);
  const evidence = githubTransportEvidence(response, {
    phase,
    path,
    attempts,
    mayHaveMutated,
  });
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  if (status === 401 || status === 403) {
    return { ok: false, error: 'GITHUB_PERMISSION_DENIED', message, ...evidence };
  }
  if (status === 404) {
    return { ok: false, error: 'GITHUB_NOT_FOUND', message: 'The repository was not found.', ...evidence };
  }
  return {
    ok: false,
    error: mayHaveMutated ? 'REPOSITORY_ARCHIVE_INDETERMINATE' : 'GITHUB_UPSTREAM_ERROR',
    message,
    ...evidence,
  };
}

async function observeRepository(apiClient, normalized, options = {}, phase = 'preflight') {
  const [owner, repo] = normalized.repo.split('/');
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.call('github', { path, method: 'GET' }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
  } catch (error) {
    return {
      ok: false,
      error: 'GITHUB_UPSTREAM_ERROR',
      message: String(error?.message || 'GitHub repository observation failed.'),
      phase,
      github_path: path,
      attempts: Number(error?.githubTransportAttempts || 1),
      may_have_mutated: false,
    };
  }

  const response = retried.response;
  if (!response || response.status < 200 || response.status >= 300) {
    return responseFailure(response, { phase, path, attempts: retried.attempts, mayHaveMutated: false });
  }

  const id = Number(response.body?.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return {
      ok: false,
      error: 'GITHUB_INVALID_RESPONSE',
      message: 'GitHub repository observation did not include a valid repository id.',
      phase,
      github_path: path,
      attempts: retried.attempts,
      may_have_mutated: false,
    };
  }

  return {
    ok: true,
    repo: typeof response.body?.full_name === 'string' && response.body.full_name ? response.body.full_name : normalized.repo,
    repository_id: id,
    archived: response.body?.archived === true,
    github_path: path,
    attempts: retried.attempts,
  };
}

function identityMismatch(normalized, observed, phase = 'preflight', mayHaveMutated = false) {
  if (observed.repository_id === normalized.expected_repository_id) return null;
  return {
    ok: false,
    error: 'GITHUB_REPOSITORY_ID_MISMATCH',
    message: 'Repository coordinate no longer resolves to the expected immutable GitHub repository id.',
    repo: normalized.repo,
    expected_repository_id: normalized.expected_repository_id,
    actual_repository_id: observed.repository_id,
    phase,
    may_have_mutated: mayHaveMutated,
  };
}

function success(normalized, observed, outcome) {
  return {
    ok: true,
    outcome,
    repo: observed.repo,
    requested_repo: normalized.repo,
    repository_id: observed.repository_id,
    expected_repository_id: normalized.expected_repository_id,
    expected_archived: false,
    archived: true,
    confirmed: true,
  };
}

async function reconcileAfterMutation(normalized, apiClient, options = {}, cause = null) {
  const observed = await observeRepository(apiClient, normalized, options, 'reconcile');
  if (observed.ok) {
    const mismatch = identityMismatch(normalized, observed, 'reconcile', true);
    if (mismatch) return mismatch;
    if (observed.archived === true) return success(normalized, observed, 'archived_after_reconcile');
  }
  return {
    ok: false,
    error: 'REPOSITORY_ARCHIVE_INDETERMINATE',
    message: 'GitHub did not provide authoritative confirmation after the archive mutation was dispatched.',
    repo: normalized.repo,
    expected_repository_id: normalized.expected_repository_id,
    actual_repository_id: observed.ok ? observed.repository_id : null,
    actual_archived: observed.ok ? observed.archived : null,
    phase: 'reconcile',
    may_have_mutated: true,
    ...(cause ? { mutation_error: String(cause?.message || cause) } : {}),
    ...(!observed.ok ? { reconciliation_error: observed.error, reconciliation_message: observed.message } : {}),
  };
}

export async function archiveGithubRepository(input, apiClient, options = {}) {
  let normalized;
  try { normalized = normalizeGithubArchiveRepositoryRequest(input); }
  catch (error) { return errorResult(error); }

  if (!apiClient || typeof apiClient.call !== 'function') {
    return { ok: false, error: 'INTERNAL_ERROR', message: 'GitHub API client is required.' };
  }

  const before = await observeRepository(apiClient, normalized, options, 'preflight');
  if (!before.ok) return before;

  const mismatch = identityMismatch(normalized, before, 'preflight', false);
  if (mismatch) return mismatch;

  if (before.archived === true) return success(normalized, before, 'already_archived');

  const path = before.github_path;
  let mutation;
  try {
    mutation = await apiClient.call('github', {
      path,
      method: 'PATCH',
      body: { archived: true },
    });
  } catch (error) {
    return reconcileAfterMutation(normalized, apiClient, options, error);
  }

  if (!mutation || mutation.status < 200 || mutation.status >= 300) {
    const status = Number(mutation?.status || 0);
    if (status === 429 || status >= 500 || status === 0) {
      return reconcileAfterMutation(normalized, apiClient, options, mutation?.body?.message || `HTTP ${status || 'unknown'}`);
    }
    return responseFailure(mutation, { phase: 'mutation', path, attempts: 1, mayHaveMutated: false });
  }

  const confirmed = await observeRepository(apiClient, normalized, options, 'confirm');
  if (!confirmed.ok) {
    return {
      ok: false,
      error: 'REPOSITORY_ARCHIVE_INDETERMINATE',
      message: 'GitHub accepted the archive mutation but authoritative confirmation was unavailable.',
      repo: normalized.repo,
      expected_repository_id: normalized.expected_repository_id,
      phase: 'confirm',
      may_have_mutated: true,
      confirmation_error: confirmed.error,
      confirmation_message: confirmed.message,
    };
  }

  const confirmedMismatch = identityMismatch(normalized, confirmed, 'confirm', true);
  if (confirmedMismatch) return confirmedMismatch;
  if (confirmed.archived !== true) {
    return {
      ok: false,
      error: 'REPOSITORY_ARCHIVE_INDETERMINATE',
      message: 'GitHub accepted the archive mutation but the repository is not authoritatively archived.',
      repo: confirmed.repo,
      expected_repository_id: normalized.expected_repository_id,
      actual_repository_id: confirmed.repository_id,
      actual_archived: false,
      phase: 'confirm',
      may_have_mutated: true,
    };
  }

  return success(normalized, confirmed, 'archived');
}

export async function archiveGithubRepositoryWithGitHubApp(input, options = {}) {
  let normalized;
  try { normalized = normalizeGithubArchiveRepositoryRequest(input); }
  catch (error) { return errorResult(error); }

  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  const domainOptions = { ...options };
  delete domainOptions.withGitHubAppApiClient;

  try {
    return await withApp(
      normalized.repo,
      (apiClient) => archiveGithubRepository(normalized, apiClient, domainOptions),
      { permissionProfile: 'archive_repository' },
    );
  } catch (error) {
    return githubAppErrorResult(error);
  }
}
