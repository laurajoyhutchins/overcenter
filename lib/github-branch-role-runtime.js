import { db } from 'hatchable';
import { applyGithubChangesetWithGitHubApp } from 'lib/github-apply-changeset.js';
import { reconcileGithubIntegrationWithGitHubApp } from 'lib/github-integration.js';
import { createGithubPullRequestWithGitHubApp } from 'lib/github-pull-request-create.js';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import {
  assertDevelopmentBase,
  assertOrdinaryWorkTarget,
  resolveRepositoryBranchRoles,
} from 'lib/repository-branch-roles.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function failure(error) {
  return {
    ok: false,
    error: error?.code || 'GITHUB_BRANCH_ROLE_ERROR',
    message: String(error?.message || error || 'branch-role validation failed'),
    ...(error?.details && typeof error.details === 'object' ? error.details : {}),
    may_have_mutated: false,
  };
}

async function rolesFor(repo, options = {}) {
  if (typeof repo !== 'string' || !REPO.test(repo.trim())) return null;
  return resolveRepositoryBranchRoles(repo, { db: options.db || db, service: options.branchRoleService });
}

export async function createGithubPullRequestRoleAware(input, options = {}) {
  const delegate = options.createPullRequest || createGithubPullRequestWithGitHubApp;
  try {
    const roles = await rolesFor(input?.repo, options);
    assertDevelopmentBase(input?.base, roles);
    return delegate(input, options);
  } catch (error) {
    if (String(error?.code || '').startsWith('REPOSITORY_BRANCH_ROLE_') || error?.code === 'GITHUB_BRANCH_ROLE_VIOLATION') return failure(error);
    throw error;
  }
}

export async function applyGithubChangesetRoleAware(input, options = {}) {
  const delegate = options.applyChangeset || applyGithubChangesetWithGitHubApp;
  try {
    const roles = await rolesFor(input?.repo, options);
    assertOrdinaryWorkTarget(input?.branch, roles);
    return delegate(input, options);
  } catch (error) {
    if (String(error?.code || '').startsWith('REPOSITORY_BRANCH_ROLE_') || error?.code === 'GITHUB_BRANCH_ROLE_VIOLATION') return failure(error);
    throw error;
  }
}

async function readPullRequestBase(repo, pullRequest) {
  const [owner, name] = String(repo || '').split('/');
  return withGitHubAppApiClient(repo, async (apiClient) => {
    const response = await apiClient.call('github', {
      method: 'GET',
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${Number(pullRequest)}`,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Overcenter/1.0' },
    });
    const status = Number(response?.status || 0);
    if (status < 200 || status >= 300) {
      const error = new Error(String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`));
      error.code = status === 403 ? 'GITHUB_APP_PERMISSION_DENIED' : 'GITHUB_UPSTREAM_ERROR';
      throw error;
    }
    return String(response?.body?.base?.ref || '').trim();
  }, { permissionProfile: 'review_pull_requests' });
}

export async function reconcileGithubIntegrationRoleAware(input, options = {}) {
  const delegate = options.reconcileIntegration || reconcileGithubIntegrationWithGitHubApp;
  try {
    const roles = await rolesFor(input?.repo, options);
    if (roles && Number.isInteger(input?.pull_request) && input.pull_request > 0) {
      const base = await (options.readPullRequestBase || readPullRequestBase)(input.repo, input.pull_request);
      assertDevelopmentBase(base, roles);
    }
    return delegate(input, options);
  } catch (error) {
    if (String(error?.code || '').startsWith('REPOSITORY_BRANCH_ROLE_') || error?.code === 'GITHUB_BRANCH_ROLE_VIOLATION') return failure(error);
    throw error;
  }
}
