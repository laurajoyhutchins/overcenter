import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REQUEST_FIELDS = new Set(['repo', 'new_name', 'expected_repository_id']);
const OUTCOMES = Object.freeze({
  ALREADY_RENAMED: 'already_renamed',
  RECONCILED_AFTER_INDETERMINATE_WRITE: 'reconciled_after_indeterminate_write',
});

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
  exactFields(input, REQUEST_FIELDS, 'request');
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
  if (!options.apiClient) {
    return { ok: false, error: 'GITHUB_TRANSPORT_UNAVAILABLE', message: 'A GitHub API transport is required.', may_have_mutated: false };
  }
  return {
    ok: false,
    error: 'GITHUB_REPOSITORY_RENAME_NOT_IMPLEMENTED',
    message: 'Repository rename behavior is not implemented yet.',
    repo: normalized.repo,
    new_repo: normalized.new_repo,
    expected_repository_id: normalized.expected_repository_id,
    supported_outcomes: Object.values(OUTCOMES),
    may_have_mutated: false,
  };
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

export async function renameGithubRepositoryWithGitHubApp(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubRepositoryRenameRequest(input);
  } catch (error) {
    return { ok: false, error: error.code || 'INVALID_REQUEST', message: error.message, ...(error.details || {}), may_have_mutated: false };
  }
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  try {
    return await withApp(
      normalized.repo,
      (apiClient) => renameGithubRepository(normalized, { ...options, apiClient }),
      { permissionProfile: 'repository_metadata' },
    );
  } catch (oldCoordinateError) {
    try {
      return await withApp(
        normalized.new_repo,
        (apiClient) => renameGithubRepository(normalized, { ...options, apiClient }),
        { permissionProfile: 'repository_metadata' },
      );
    } catch {
      return authFailure(oldCoordinateError);
    }
  }
}
