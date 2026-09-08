import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { deleteGithubActionsRun, normalizeGithubActionsRunDeleteRequest } from 'lib/github-actions-run-delete.js';

function failure(error, message, details = {}) {
  return { ok:false, error, message, may_have_mutated:false, ...details };
}

export async function deleteGithubActionsRunWithGitHubApp(input, options = {}) {
  let normalized;
  try {
    normalized = normalizeGithubActionsRunDeleteRequest(input);
  } catch (error) {
    return failure(error?.code || 'INVALID_REQUEST', String(error?.message || error), error?.details || {});
  }

  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  try {
    return await withApp(
      normalized.repo,
      (apiClient) => deleteGithubActionsRun(normalized, { apiClient }),
      { permissionProfile:'actions_storage_delete' },
    );
  } catch (error) {
    const message = String(error?.message || 'GitHub App authentication failed.');
    if (/config\/get 412|declared as required but not set/i.test(message)) {
      return failure('GITHUB_APP_SETUP_REQUIRED', 'Configure the GitHub App ID and private key in Hatchable Setup before using this command.');
    }
    const status = Number(error?.status || 0);
    if (status === 404) return failure('GITHUB_APP_INSTALLATION_NOT_FOUND', 'The GitHub App is not installed for this repository.', { upstream_status:404 });
    if (status === 401 || status === 403) return failure('GITHUB_APP_PERMISSION_DENIED', message, { upstream_status:status });
    return failure(error?.code || 'GITHUB_APP_AUTH_ERROR', message, status ? { upstream_status:status } : {});
  }
}