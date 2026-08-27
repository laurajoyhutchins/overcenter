import { db } from 'hatchable';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { reconcileGithubProductionBranchPolicy } from 'lib/github-production-branch-policy.js';
import { resolveRepositoryBranchRoles } from 'lib/repository-branch-roles.js';

function repoBase(repo) {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function upstream(response, operation) {
  const status = Number(response?.status || 0);
  const error = new Error(`${operation}: ${String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`)}`);
  error.code = status === 401 || status === 403 ? 'GITHUB_APP_PERMISSION_DENIED'
    : status === 404 ? 'GITHUB_NOT_FOUND' : 'GITHUB_UPSTREAM_ERROR';
  error.status = status || null;
  throw error;
}

export function createGithubProductionBranchPolicyAdapter(repo) {
  const base = repoBase(repo);
  async function withPolicy(fn) { return withGitHubAppApiClient(repo, fn, { permissionProfile:'branch_policy' }); }
  async function request(method, path, body) {
    return withPolicy(async apiClient => {
      const response = await apiClient.call('github', {
        method,
        path,
        ...(body === undefined ? {} : { body }),
        headers: { Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10', 'User-Agent':'Overcenter/1.0' },
      });
      if (Number(response?.status) < 200 || Number(response?.status) >= 300) upstream(response, `${method} ${path}`);
      return response.body;
    });
  }
  return {
    async getBranch(_repo, branch) {
      const body = await request('GET', `${base}/branches/${encodeURIComponent(branch)}`);
      return { branch, sha:String(body?.commit?.sha || '').toLowerCase() };
    },
    async listRulesets() { return request('GET', `${base}/rulesets`); },
    async getRuleset(_repo, id) { return request('GET', `${base}/rulesets/${Number(id)}`); },
    async createRuleset(_repo, body) { return request('POST', `${base}/rulesets`, body); },
    async updateRuleset(_repo, id, body) { return request('PUT', `${base}/rulesets/${Number(id)}`, body); },
  };
}

export async function reconcileGithubProductionBranchPolicyWithGitHubApp(input, options = {}) {
  try {
    const repo = String(input?.repo || '').trim();
    const branchRoles = options.branchRoles || await resolveRepositoryBranchRoles(repo, { db:options.db || db, service:options.branchRoleService });
    const github = options.github || createGithubProductionBranchPolicyAdapter(repo);
    return reconcileGithubProductionBranchPolicy(input, { github, branchRoles });
  } catch (error) {
    return { ok:false, error:error?.code || 'GITHUB_PRODUCTION_BRANCH_POLICY_ERROR', message:String(error?.message || error), ...(error?.status ? { upstream_status:Number(error.status) } : {}), may_have_mutated:false };
  }
}
