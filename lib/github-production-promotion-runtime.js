import { db } from 'hatchable';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import {
  normalizeGithubProductionPromotionRequest,
  promoteGithubProduction,
} from 'lib/github-production-promotion.js';
import { createCompactGithubProductionPromotionReceiptStore } from 'lib/compact-github-production-promotion-receipt-store.js';
import { createCompactProofStateStore } from 'lib/compact-proof-state-store.js';
import { persistExactProductionVerificationProof } from 'lib/github-production-verification-proof.js';
import { mayHaveMutated, mutationCertaintyFromEvidence } from 'lib/mutation-certainty.js';
import { resolveRepositoryBranchRoles } from 'lib/repository-branch-roles.js';

function repoBase(repo) {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function statusError(response, operation) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const error = new Error(`${operation}: ${message}`);
  error.code = status === 401 || status === 403 ? 'GITHUB_APP_PERMISSION_DENIED'
    : status === 404 ? 'GITHUB_NOT_FOUND'
      : 'GITHUB_UPSTREAM_ERROR';
  error.status = status || null;
  return error;
}

async function withContents(repo, fn) {
  return withGitHubAppApiClient(repo, fn, { permissionProfile: 'changeset' });
}

async function withActionsRead(repo, fn) {
  return withGitHubAppApiClient(repo, fn, { permissionProfile: 'actions_storage_read' });
}

export function createGithubProductionPromotionAdapter(repo) {
  const base = repoBase(repo);
  return {
    async getBranch(_repo, branch) {
      return withContents(repo, async (apiClient) => {
        const response = await apiClient.call('github', {
          method: 'GET',
          path: `${base}/branches/${encodeURIComponent(branch)}`,
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Overcenter/1.0' },
        });
        if (Number(response?.status) < 200 || Number(response?.status) >= 300) throw statusError(response, 'read branch');
        return { branch, sha: String(response?.body?.commit?.sha || '').toLowerCase() };
      });
    },
    async compare(_repo, baseSha, headSha) {
      return withContents(repo, async (apiClient) => {
        const response = await apiClient.call('github', {
          method: 'GET',
          path: `${base}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Overcenter/1.0' },
        });
        if (Number(response?.status) < 200 || Number(response?.status) >= 300) throw statusError(response, 'compare production ancestry');
        return { status: String(response?.body?.status || '') };
      });
    },
    async getWorkflowRun(_repo, runId) {
      return withActionsRead(repo, async (apiClient) => {
        const response = await apiClient.call('github', {
          method: 'GET',
          path: `${base}/actions/runs/${Number(runId)}`,
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Overcenter/1.0' },
        });
        if (Number(response?.status) < 200 || Number(response?.status) >= 300) throw statusError(response, 'read exact-revision verification run');
        const body = response.body || {};
        return {
          id: Number(body.id),
          path: String(body.path || ''),
          event: String(body.event || ''),
          head_branch: String(body.head_branch || ''),
          head_sha: String(body.head_sha || '').toLowerCase(),
          status: String(body.status || ''),
          conclusion: body.conclusion == null ? null : String(body.conclusion),
          html_url: body.html_url ? String(body.html_url) : null,
        };
      });
    },
    async updateBranch(_repo, branch, sha) {
      return withContents(repo, async (apiClient) => {
        const response = await apiClient.call('github', {
          method: 'PATCH',
          path: `${base}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
          body: { sha, force: false },
          headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Overcenter/1.0' },
        });
        if (Number(response?.status) < 200 || Number(response?.status) >= 300) throw statusError(response, 'advance production branch');
        return { ok: true, sha: String(response?.body?.object?.sha || sha).toLowerCase() };
      });
    },
  };
}

function errorResult(error) {
  const certainty = mutationCertaintyFromEvidence(error, 'none');
  return {
    ok: false,
    error: error?.code || 'GITHUB_PRODUCTION_PROMOTION_ERROR',
    message: String(error?.message || error || 'production promotion failed'),
    ...(error?.status ? { upstream_status: Number(error.status) } : {}),
    may_have_mutated: mayHaveMutated(certainty),
  };
}

function observedAt(now) {
  if (typeof now !== 'function') return undefined;
  const value = now();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function promoteGithubProductionWithGitHubApp(input, options = {}) {
  const semanticInput = input && typeof input === 'object' && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'run_id'))
    : input;
  let normalized;
  try { normalized = normalizeGithubProductionPromotionRequest(semanticInput); }
  catch (error) { return errorResult(error); }
  try {
    const branchRoles = options.branchRoles || await resolveRepositoryBranchRoles(normalized.repo, { db: options.db || db, service: options.branchRoleService });
    const compactReceipts = options.receipts === undefined
      ? createCompactGithubProductionPromotionReceiptStore(options.db || db, { now:options.now, runId:options.run_id || input?.run_id || null })
      : null;
    const receipts = compactReceipts || options.receipts;
    const proofs = options.proofs === undefined && options.receipts === undefined
      ? createCompactProofStateStore(options.db || db)
      : options.proofs || null;
    const baseGithub = options.github || createGithubProductionPromotionAdapter(normalized.repo);
    const github = {
      ...baseGithub,
      ...(proofs ? {
        async getWorkflowRun(...args) {
          const run = await baseGithub.getWorkflowRun(...args);
          await persistExactProductionVerificationProof({
            proofs,
            normalized,
            branchRoles,
            workflowRun:run,
            observedAt:observedAt(options.now),
          });
          return run;
        },
      } : {}),
      ...(compactReceipts ? {
        async updateBranch(...args) {
          await compactReceipts.markMutationBoundary(normalized);
          return baseGithub.updateBranch(...args);
        },
      } : {}),
    };
    return await promoteGithubProduction(normalized, { github, branchRoles, receipts });
  } catch (error) {
    return errorResult(error);
  }
}