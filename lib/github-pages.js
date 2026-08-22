import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9._/+\-]+$/;

function normalizeRequest(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const allowed = new Set(['repo', 'dispatch', 'ref']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw Object.assign(new Error('request contains unknown fields'), { code: 'INVALID_REQUEST', httpStatus: 422 });
  }
  const repo = String(body.repo || '').trim();
  if (!REPO.test(repo)) {
    throw Object.assign(new Error('repo must be in owner/name form'), { code: 'INVALID_REPOSITORY', httpStatus: 422 });
  }
  const dispatch = body.dispatch === true;
  const ref = String(body.ref || 'main').trim();
  if (!REF.test(ref) || ref.startsWith('/') || ref.endsWith('/') || ref.includes('..') || ref.includes('//')) {
    throw Object.assign(new Error('ref must be a safe Git branch or tag name'), { code: 'INVALID_REF', httpStatus: 422 });
  }
  return { repo, dispatch, ref };
}

function failFromGitHub(response, operation) {
  const status = Number(response?.status || 0);
  const message = response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`;
  const code = status === 401 || status === 403
    ? 'GITHUB_APP_PERMISSION_DENIED'
    : status === 404
      ? 'GITHUB_NOT_FOUND'
      : 'GITHUB_UPSTREAM_ERROR';
  throw Object.assign(new Error(String(message)), {
    code,
    httpStatus: status >= 400 && status < 600 ? status : 502,
    details: { operation, upstream_status: status },
  });
}

async function ensurePagesSite(repo, path) {
  return withGitHubAppApiClient(repo, async (apiClient) => {
    const current = await apiClient.call('github', { path, method: 'GET' });
    if (current.status === 200) {
      if (current.body?.build_type !== 'workflow') {
        const update = await apiClient.call('github', {
          path,
          method: 'PUT',
          body: { build_type: 'workflow' },
        });
        if (update.status !== 204) failFromGitHub(update, 'pages.update');
      }
      const verified = await apiClient.call('github', { path, method: 'GET' });
      if (verified.status !== 200) failFromGitHub(verified, 'pages.verify');
      return {
        created: false,
        build_type: verified.body?.build_type || null,
        html_url: verified.body?.html_url || null,
        status: verified.body?.status || null,
      };
    }

    if (current.status !== 404) failFromGitHub(current, 'pages.inspect');

    const created = await apiClient.call('github', {
      path,
      method: 'POST',
      body: { build_type: 'workflow' },
    });
    if (created.status !== 201) failFromGitHub(created, 'pages.create');

    const verified = await apiClient.call('github', { path, method: 'GET' });
    if (verified.status !== 200) failFromGitHub(verified, 'pages.verify');
    return {
      created: true,
      build_type: verified.body?.build_type || null,
      html_url: verified.body?.html_url || created.body?.html_url || null,
      status: verified.body?.status || created.body?.status || null,
    };
  }, { permissionProfile: 'pages_ensure' });
}

async function dispatchPagesWorkflow(repo, owner, name, ref) {
  const workflowPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/pages.yml`;
  return withGitHubAppApiClient(repo, async (apiClient) => {
    const dispatch = await apiClient.call('github', {
      path: `${workflowPath}/dispatches`,
      method: 'POST',
      body: { ref },
    });
    if (dispatch.status !== 200 && dispatch.status !== 204) failFromGitHub(dispatch, 'pages.workflow_dispatch');

    const directRunId = Number(dispatch.body?.workflow_run_id || 0) || null;
    if (directRunId) {
      return {
        dispatched: true,
        ref,
        workflow_run_id: directRunId,
        workflow_run_status: null,
        workflow_run_conclusion: null,
        workflow_run_html_url: dispatch.body?.html_url || null,
        workflow_run_head_sha: null,
      };
    }

    let latest = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const runs = await apiClient.call('github', {
        path: `${workflowPath}/runs`,
        method: 'GET',
        query: { branch: ref, event: 'workflow_dispatch', per_page: 5 },
      });
      if (runs.status !== 200) failFromGitHub(runs, 'pages.workflow_runs');
      latest = Array.isArray(runs.body?.workflow_runs) ? runs.body.workflow_runs[0] || null : null;
      if (latest) break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return {
      dispatched: true,
      ref,
      workflow_run_id: latest?.id || null,
      workflow_run_status: latest?.status || null,
      workflow_run_conclusion: latest?.conclusion || null,
      workflow_run_html_url: latest?.html_url || null,
      workflow_run_head_sha: latest?.head_sha || null,
    };
  }, { permissionProfile: 'pages_dispatch' });
}

export async function ensureGitHubPagesWithGitHubApp(input) {
  const { repo, dispatch, ref } = normalizeRequest(input);
  const [owner, name] = repo.split('/');
  const pagesPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pages`;
  const ensured = await ensurePagesSite(repo, pagesPath);
  const dispatched = dispatch
    ? await dispatchPagesWorkflow(repo, owner, name, ref)
    : {
        dispatched: false,
        ref: null,
        workflow_run_id: null,
        workflow_run_status: null,
        workflow_run_conclusion: null,
        workflow_run_html_url: null,
        workflow_run_head_sha: null,
      };

  return {
    ok: true,
    repo,
    ...ensured,
    ...dispatched,
  };
}