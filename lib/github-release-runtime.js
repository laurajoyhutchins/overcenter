import { db } from 'hatchable';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { createGithubRelease, createGithubReleaseReceiptStore, normalizeGithubReleaseRequest } from 'lib/github-release.js';

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
  const receiptStore = options.receiptStore === undefined
    ? createGithubReleaseReceiptStore(options.db || db)
    : options.receiptStore;
  return withGitHubAppApiClient(
    normalized.repo,
    (apiClient) => createGithubRelease(normalized, { apiClient, receiptStore }),
    { permissionProfile: 'release' },
  );
}
