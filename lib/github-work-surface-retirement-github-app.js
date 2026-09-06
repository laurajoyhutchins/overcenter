import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import {
  closeGithubIssue,
  closeGithubPullRequest,
  normalizeGithubIssueCloseRequest,
  normalizeGithubPullRequestCloseRequest,
} from 'lib/github-work-surface-retirement.js';

function fail(error, message, details = null) {
  return { ok:false, error, message, ...(details && typeof details === 'object' ? details : {}) };
}

function mapAuthError(error, kind) {
  const message = String(error?.message || 'GitHub App authentication failed');
  if (/config\/get 412|declared as required but not set/i.test(message)) return fail('GITHUB_APP_SETUP_REQUIRED', 'Configure the GitHub App before retiring GitHub work surfaces');
  if ([401, 403, 422].includes(Number(error?.status))) return fail('GITHUB_APP_PERMISSION_DENIED', message, { upstream_status:Number(error.status), required_permissions:kind === 'issue' ? { issues:'write' } : { pull_requests:'write' } });
  if (Number(error?.status) === 404) return fail('GITHUB_APP_INSTALLATION_NOT_FOUND', 'The GitHub App is not installed for this repository', { upstream_status:404 });
  return fail(error?.code || 'GITHUB_APP_AUTH_ERROR', message, error?.status ? { upstream_status:Number(error.status) } : null);
}

export async function closeGithubIssueWithGitHubApp(input, options = {}) {
  const normalized = normalizeGithubIssueCloseRequest(input);
  if (!normalized.ok) return normalized;
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  try {
    return await withApp(normalized.repo, (apiClient) => closeGithubIssue(normalized, { ...options, apiClient }), { permissionProfile:'issue_close' });
  } catch (error) { return mapAuthError(error, 'issue'); }
}

export async function closeGithubPullRequestWithGitHubApp(input, options = {}) {
  const normalized = normalizeGithubPullRequestCloseRequest(input);
  if (!normalized.ok) return normalized;
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  try {
    return await withApp(normalized.repo, (apiClient) => closeGithubPullRequest(normalized, { ...options, apiClient }), { permissionProfile:'pull_request_close' });
  } catch (error) { return mapAuthError(error, 'pull_request'); }
}