import { canonicalJson, sha256Text } from 'lib/canonical-json.js';
import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { promoteGithubProductionWithGitHubApp } from 'lib/github-production-promotion-runtime.js';
import { promoteProduction } from 'lib/production-promotion-operation.js';
import { resolveRepositoryBranchRoles } from 'lib/repository-branch-roles.js';

const WORKFLOW_PATH = '.github/workflows/exact-revision-v8.yml';
const SHA40 = /^[0-9a-f]{40}$/;

function repoBase(repo) {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function upstreamError(response, operation) {
  const status = Number(response?.status || 0);
  const error = new Error(`${operation}: ${String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`)}`);
  error.code = status === 401 || status === 403 ? 'GITHUB_APP_PERMISSION_DENIED'
    : status === 404 ? 'GITHUB_NOT_FOUND'
      : 'GITHUB_UPSTREAM_ERROR';
  error.status = status || null;
  return error;
}

async function githubGet(repo, permissionProfile, path) {
  return withGitHubAppApiClient(repo, async (apiClient) => {
    const response = await apiClient.call('github', {
      method:'GET',
      path,
      headers:{ Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10', 'User-Agent':'Overcenter/1.0' },
    });
    if (Number(response?.status) < 200 || Number(response?.status) >= 300) throw upstreamError(response, 'read production promotion authority');
    return response.body || {};
  }, { permissionProfile });
}

function strictPromotionError(result) {
  const error = new Error(String(result?.message || 'production promotion failed'));
  error.code = result?.error || 'PRODUCTION_PROMOTION_ERROR';
  error.details = result || null;
  error.may_have_mutated = result?.may_have_mutated === true;
  return error;
}

export function productionPromotionCommandResult(result) {
  const sourceRevision = String(result?.source_revision || '').trim().toLowerCase();
  const previousProductionRevision = String(result?.previous_production_revision || '').trim().toLowerCase();
  const productionRevision = String(result?.production_revision || '').trim().toLowerCase();
  const verificationRef = String(result?.verification_ref || '').trim();
  if (!SHA40.test(sourceRevision) || !SHA40.test(previousProductionRevision) || !SHA40.test(productionRevision) || verificationRef.length === 0) {
    const error = new Error('production promotion returned invalid evidence');
    error.code = 'PRODUCTION_PROMOTION_RESULT_INVALID';
    throw error;
  }
  return Object.freeze({
    ok:true,
    source_revision:sourceRevision,
    previous_production_revision:previousProductionRevision,
    production_revision:productionRevision,
    verification_ref:verificationRef,
  });
}

export function productionPromotionFor(options = {}) {
  const db = options.db;
  return Object.freeze({
    async promote(intent) {
      const result = await promoteProduction(intent, {
        async resolveBranchRoles(repo) {
          const roles = await resolveRepositoryBranchRoles(repo, { db });
          if (!roles?.development_branch || !roles?.production_branch) throw new Error('PRODUCTION_PROMOTION_BRANCH_ROLES_UNAVAILABLE');
          return { development:roles.development_branch, production:roles.production_branch };
        },
        async readBranchHead(repo, branch) {
          const body = await githubGet(repo, 'changeset', `${repoBase(repo)}/branches/${encodeURIComponent(branch)}`);
          const revision = String(body?.commit?.sha || '').toLowerCase();
          if (!SHA40.test(revision)) throw new Error('PRODUCTION_PROMOTION_BRANCH_HEAD_UNAVAILABLE');
          return revision;
        },
        async verifyExactRevision(repo, revision) {
          const path = `${repoBase(repo)}/actions/runs?head_sha=${encodeURIComponent(revision)}&event=push&status=success&per_page=100`;
          const body = await githubGet(repo, 'actions_storage_read', path);
          const matches = (Array.isArray(body?.workflow_runs) ? body.workflow_runs : [])
            .filter((run) => String(run?.path || '') === WORKFLOW_PATH
              && String(run?.head_branch || '') === 'dev'
              && String(run?.head_sha || '').toLowerCase() === revision
              && String(run?.status || '') === 'completed'
              && String(run?.conclusion || '') === 'success')
            .sort((left, right) => Number(right?.id || 0) - Number(left?.id || 0));
          const runId = Number(matches[0]?.id || 0);
          return {
            revision,
            verified:Number.isSafeInteger(runId) && runId > 0,
            verification_ref:runId > 0 ? `github-actions-run:${runId}` : '',
          };
        },
        async promoteVerifiedRevision(request) {
          const runId = Number(String(request.verification_ref || '').replace(/^github-actions-run:/, ''));
          if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('PRODUCTION_PROMOTION_VERIFICATION_EVIDENCE_INVALID');
          const digest = await sha256Text(canonicalJson(request));
          const result = await promoteGithubProductionWithGitHubApp({
            repo:request.repo,
            candidate_sha:request.source_revision,
            observed_development_head:request.source_revision,
            observed_production_head:request.production_revision,
            verification_run_id:runId,
            idempotency_key:`semantic-production-promote:${digest}`,
          }, { db });
          if (result?.ok !== true) throw strictPromotionError(result);
          return { production_revision:String(result.new_production_head || '').toLowerCase() };
        },
      });
      return productionPromotionCommandResult(result);
    },
  });
}