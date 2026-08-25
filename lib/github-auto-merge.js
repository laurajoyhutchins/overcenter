import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function fail(code, message, details = null, httpStatus = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.httpStatus = httpStatus;
  throw error;
}

function exactFields(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail('INVALID_REQUEST', 'request contains unknown fields', { unknown }, 422);
}

function validateRepo(value) {
  const repo = String(value || '').trim();
  if (!REPO.test(repo)) fail('INVALID_REPOSITORY', 'repo must be in owner/repo form', { repo }, 422);
  return repo;
}

function validateBoolean(value, field) {
  if (typeof value !== 'boolean') fail('INVALID_REQUEST', `${field} must be a boolean`, { field }, 422);
  return value;
}

export function normalizeGithubAutoMergeRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_REQUEST', 'request must be an object', null, 422);
  }
  exactFields(input, new Set(['repo', 'enabled', 'expected_state']));
  const normalized = {
    repo: validateRepo(input.repo),
    enabled: validateBoolean(input.enabled, 'enabled'),
  };
  if (Object.prototype.hasOwnProperty.call(input, 'expected_state')) {
    normalized.expected_state = validateBoolean(input.expected_state, 'expected_state');
  }
  return normalized;
}

function repoPath(repo) {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function transportFailure(response, phase, mayHaveMutated = false) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const evidence = githubTransportEvidence(response, {
    phase,
    path: response?.github_path || null,
    attempts: 1,
    mayHaveMutated,
  });
  if (status === 401 || status === 403) {
    return {
      ok: false,
      error: 'GITHUB_APP_PERMISSION_DENIED',
      message,
      upstream_status: status,
      required_permissions: { administration: 'write' },
      ...evidence,
    };
  }
  if (status === 404) {
    return { ok: false, error: 'GITHUB_NOT_FOUND', message, upstream_status: status, ...evidence };
  }
  return {
    ok: false,
    error: 'GITHUB_UPSTREAM_ERROR',
    message,
    ...(status ? { upstream_status: status } : {}),
    ...evidence,
  };
}

async function readRepository(apiClient, normalized, options = {}, phase = 'inspect') {
  const path = repoPath(normalized.repo);
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
      message: String(error?.message || 'GitHub repository read failed.'),
      phase,
      github_path: path,
      attempts: Number(error?.githubTransportAttempts || 1),
      may_have_mutated: false,
    };
  }
  const response = retried.response;
  if (!response || response.status < 200 || response.status >= 300) {
    const failure = transportFailure(response, phase, false);
    failure.github_path = path;
    failure.attempts = retried.attempts;
    return failure;
  }
  return {
    ok: true,
    enabled: Boolean(response.body?.allow_auto_merge),
    evidence: githubTransportEvidence(response, {
      phase,
      path,
      attempts: retried.attempts,
      mayHaveMutated: false,
    }),
  };
}

function success(normalized, outcome, before, after, changed, evidence = {}) {
  return {
    ok: true,
    outcome,
    repo: normalized.repo,
    desired_state: normalized.enabled,
    before: { enabled: before },
    after: { enabled: after },
    changed,
    verified: true,
    evidence,
  };
}

async function verifyAfterPossibleWrite(apiClient, normalized, before, options, outcome) {
  const verified = await readRepository(apiClient, normalized, options, 'verify');
  if (verified.ok && verified.enabled === normalized.enabled) {
    return success(normalized, outcome, before, verified.enabled, true, { verify: verified.evidence });
  }
  return {
    ok: false,
    error: 'GITHUB_AUTO_MERGE_INDETERMINATE',
    message: verified.ok
      ? 'GitHub did not report the requested auto-merge state after mutation.'
      : 'Auto-merge mutation may have occurred, but authoritative verification failed.',
    repo: normalized.repo,
    desired_state: normalized.enabled,
    before: { enabled: before },
    ...(verified.ok ? { observed_state: verified.enabled } : { verification_error: verified.error }),
    phase: 'verify',
    may_have_mutated: true,
  };
}

export async function ensureGithubAutoMerge(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubAutoMergeRequest(input);
  } catch (error) {
    return {
      ok: false,
      error: error.code || 'INVALID_REQUEST',
      message: error.message,
      ...(error.details || {}),
      ...(error.httpStatus ? { httpStatus: error.httpStatus } : {}),
    };
  }

  const apiClient = options.apiClient;
  if (!apiClient) {
    return { ok: false, error: 'GITHUB_TRANSPORT_UNAVAILABLE', message: 'A GitHub API transport is required.' };
  }

  const observed = await readRepository(apiClient, normalized, options, 'inspect');
  if (!observed.ok) return observed;
  const before = observed.enabled;

  if (before === normalized.enabled) {
    return success(normalized, 'already_compliant', before, before, false, { inspect: observed.evidence });
  }

  if (Object.prototype.hasOwnProperty.call(normalized, 'expected_state') && before !== normalized.expected_state) {
    return {
      ok: false,
      error: 'GITHUB_AUTO_MERGE_STATE_CHANGED',
      message: 'Observed repository auto-merge state does not match expected_state.',
      repo: normalized.repo,
      expected_state: normalized.expected_state,
      observed_state: before,
      desired_state: normalized.enabled,
      phase: 'precondition',
      may_have_mutated: false,
    };
  }

  const path = repoPath(normalized.repo);
  let write;
  try {
    write = await apiClient.call('github', {
      path,
      method: 'PATCH',
      body: { allow_auto_merge: normalized.enabled },
    });
  } catch (error) {
    return verifyAfterPossibleWrite(apiClient, normalized, before, options, 'reconciled_after_indeterminate_write');
  }

  if (!write || write.status < 200 || write.status >= 300) {
    const status = Number(write?.status || 0);
    if (status >= 500 || status === 0) {
      return verifyAfterPossibleWrite(apiClient, normalized, before, options, 'reconciled_after_indeterminate_write');
    }
    const failure = transportFailure(write, 'write', false);
    failure.github_path = path;
    return failure;
  }

  return verifyAfterPossibleWrite(apiClient, normalized, before, options, 'updated');
}

function authFailure(error) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  const status = Number(error?.status || 0);
  if (/config\/get 412|declared as required but not set/i.test(message)) {
    return { ok: false, error: 'GITHUB_APP_SETUP_REQUIRED', message: 'Configure the GitHub App ID and private key before using this command.' };
  }
  if (status === 401 || status === 403 || status === 422) {
    return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', message, ...(status ? { upstream_status: status } : {}) };
  }
  if (status === 404) {
    return { ok: false, error: 'GITHUB_APP_INSTALLATION_NOT_FOUND', message: 'The GitHub App is not installed for this repository.', upstream_status: 404 };
  }
  return { ok: false, error: error?.code || 'GITHUB_APP_AUTH_ERROR', message, ...(status ? { upstream_status: status } : {}) };
}

export async function ensureGithubAutoMergeWithGitHubApp(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubAutoMergeRequest(input);
  } catch (error) {
    return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}) };
  }
  try {
    return await withGitHubAppApiClient(
      normalized.repo,
      (apiClient) => ensureGithubAutoMerge(normalized, { ...options, apiClient }),
      { permissionProfile: 'auto_merge' },
    );
  } catch (error) {
    return authFailure(error);
  }
}
