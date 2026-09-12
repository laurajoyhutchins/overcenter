// Runtime database and GitHub auth are injected by the composition root.
import {
  createGithubRelease,
  normalizeGithubReleaseRequest,
  observeGithubRelease,
  classifyGithubRelease,
} from 'lib/github-release.js';

function fail(error, message, details = {}) {
  return { ok: false, error, message, details, may_have_mutated: false };
}

export async function observeGithubReleaseWithGitHubApp(input, options = {}) {
  const semanticInput = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'run_id'))
    : input;
  let normalized;
  try {
    normalized = normalizeGithubReleaseRequest(semanticInput);
  } catch (error) {
    return fail(error.code || 'INVALID_REQUEST', error.message, error.details || {});
  }
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  if (typeof withGitHubAppApiClient !== 'function') {
    return fail('RUNTIME_PROVIDER_MISSING', 'release runtime requires explicit GitHub App auth provider');
  }
  return withGitHubAppApiClient(
    normalized.repo,
    async (apiClient) => {
      const observed = await observeGithubRelease(apiClient, normalized);
      if (observed?.ok !== true) return observed;
      return {
        ...observed,
        classification:classifyGithubRelease(observed, normalized),
      };
    },
    { permissionProfile:'release' },
  );
}

export async function createGithubReleaseWithGitHubApp(input, options = {}) {
  const semanticInput = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'run_id'))
    : input;
  let normalized;
  try {
    normalized = normalizeGithubReleaseRequest(semanticInput);
  } catch (error) {
    return fail(error.code || 'INVALID_REQUEST', error.message, error.details || {});
  }
  const db = options.db;
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  if (!db || typeof db.query !== 'function' || typeof withGitHubAppApiClient !== 'function') {
    return fail('RUNTIME_PROVIDER_MISSING', 'release runtime requires explicit database and GitHub App auth providers');
  }
  if (options.receiptStore === undefined) {
    return fail('EXECUTION_TRANSACTION_REQUIRED', 'direct GitHub release execution is disabled; use the execution transaction kernel');
  }
  return withGitHubAppApiClient(
    normalized.repo,
    (apiClient) => createGithubRelease(normalized, { apiClient, receiptStore:options.receiptStore }),
    { permissionProfile: 'release' },
  );
}
