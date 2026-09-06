// Runtime database and GitHub auth are injected by the composition root.
import { createGithubRelease, normalizeGithubReleaseRequest } from 'lib/github-release.js';
import { createCompactGithubReleaseReceiptStore } from 'lib/compact-github-release-receipt-store.js';

function fail(error, message, details = {}) {
  return { ok: false, error, message, details, may_have_mutated: false };
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
  const receiptStore = options.receiptStore === undefined
    ? createCompactGithubReleaseReceiptStore(db, { now:options.now, runId:options.run_id || input?.run_id || null })
    : options.receiptStore;
  return withGitHubAppApiClient(
    normalized.repo,
    (apiClient) => createGithubRelease(normalized, { apiClient, receiptStore }),
    { permissionProfile: 'release' },
  );
}