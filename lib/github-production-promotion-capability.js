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

export function createGithubProductionPromotionCapability(repo, options = {}) {
  const withGitHubAppApiClient = options.withGitHubAppApiClient;
  const base = repoBase(repo);

  async function call(method, path, body = undefined, permissionProfile = 'changeset') {
    if (typeof withGitHubAppApiClient !== 'function') {
      throw Object.assign(new Error('GitHub App auth provider is required'), {
        code:'RUNTIME_PROVIDER_MISSING',
        details:{ provider:'githubAppAuth' },
        may_have_mutated:false,
      });
    }
    return withGitHubAppApiClient(repo, async (apiClient) => {
      const response = await apiClient.call('github', {
        method,
        path,
        ...(body === undefined ? {} : { body }),
        headers:{
          Accept:'application/vnd.github+json',
          'X-GitHub-Api-Version':'2026-03-10',
          'User-Agent':'Overcenter/1.0',
        },
      });
      if (Number(response?.status) < 200 || Number(response?.status) >= 300) {
        throw upstreamError(response, 'GitHub production promotion');
      }
      return response.body || {};
    }, { permissionProfile });
  }

  return Object.freeze({
    async readBranch(branch) {
      const body = await call(
        'GET',
        `${base}/branches/${encodeURIComponent(branch)}`,
      );
      const sha = String(body?.commit?.sha || '').toLowerCase();
      if (!SHA40.test(sha)) throw new Error('PRODUCTION_PROMOTION_BRANCH_HEAD_UNAVAILABLE');
      return Object.freeze({ branch, sha });
    },

    async findExactVerification(revision) {
      const body = await call(
        'GET',
        `${base}/actions/runs?head_sha=${encodeURIComponent(revision)}&event=push&status=success&per_page=100`,
        undefined,
        'actions_storage_read',
      );
      const matches = (Array.isArray(body?.workflow_runs) ? body.workflow_runs : [])
        .filter((run) => String(run?.path || '') === '.github/workflows/exact-revision-v8.yml'
          && String(run?.event || '') === 'push'
          && String(run?.head_branch || '') === 'dev'
          && String(run?.head_sha || '').toLowerCase() === revision
          && String(run?.status || '') === 'completed'
          && String(run?.conclusion || '') === 'success')
        .sort((left, right) => Number(right?.id || 0) - Number(left?.id || 0));
      const run = matches[0] || null;
      const runId = Number(run?.id || 0);
      return Object.freeze({
        revision,
        verified:Number.isSafeInteger(runId) && runId > 0,
        verification_ref:runId > 0 ? `github-actions-run:${runId}` : '',
      });
    },

    async readVerification(runId) {
      return call(
        'GET',
        `${base}/actions/runs/${encodeURIComponent(String(runId))}`,
        undefined,
        'actions_storage_read',
      );
    },

    async compare(baseSha, headSha) {
      const body = await call(
        'GET',
        `${base}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
      );
      return Object.freeze({ status:String(body?.status || '') });
    },

    async updateBranch(branch, sha) {
      const body = await call(
        'PATCH',
        `${base}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`,
        { sha, force:false },
      );
      return Object.freeze({ sha:String(body?.object?.sha || sha).toLowerCase() });
    },
  });
}
