import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9._/+\-]+$/;
const WORKFLOW = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const SHA40 = /^[0-9a-f]{40}$/;
const INPUT_KEY = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_INPUTS = 10;
const MAX_INPUT_VALUE = 4096;
const MAX_CONFIRM_ATTEMPTS = 8;
const CONFIRM_DELAY_MS = 250;
const CREATION_SKEW_MS = 5000;

function failure(code, message, details = {}, options = {}) {
  return Object.assign(new Error(message), {
    code,
    httpStatus: options.httpStatus ?? 422,
    may_have_mutated: options.mayHaveMutated === true,
    details,
  });
}

function githubFailure(response, operation, options = {}) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const code = status === 401 || status === 403
    ? 'GITHUB_APP_PERMISSION_DENIED'
    : status === 404
      ? 'GITHUB_NOT_FOUND'
      : 'GITHUB_UPSTREAM_ERROR';
  throw failure(code, message, { operation, upstream_status: status || null }, {
    httpStatus: status >= 400 && status < 600 ? status : 502,
    mayHaveMutated: options.mayHaveMutated,
  });
}

function normalizeInputs(input) {
  if (input === undefined) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw failure('INVALID_INPUTS', 'inputs must be an object of bounded string values');
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_INPUTS) throw failure('INVALID_INPUTS', `inputs may contain at most ${MAX_INPUTS} values`);
  const normalized = {};
  for (const [key, value] of entries) {
    if (!INPUT_KEY.test(key)) throw failure('INVALID_INPUTS', 'input keys must be safe workflow input identifiers', { key });
    if (typeof value !== 'string' || value.length > MAX_INPUT_VALUE) {
      throw failure('INVALID_INPUTS', `workflow input ${key} must be a bounded string`, { key });
    }
    normalized[key] = value;
  }
  return normalized;
}

function normalizeRequest(input) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const allowed = new Set(['repo', 'workflow', 'ref', 'expected_head', 'inputs']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw failure('INVALID_REQUEST', 'request contains unknown fields', { fields: unknown.sort() });

  const repo = String(body.repo || '').trim();
  if (!REPO.test(repo)) throw failure('INVALID_REPOSITORY', 'repo must be in owner/name form');

  const workflow = String(body.workflow || '').trim();
  if (!WORKFLOW.test(workflow)) throw failure('INVALID_WORKFLOW', 'workflow must be a workflow YAML filename');

  const ref = String(body.ref || '').trim();
  if (!REF.test(ref) || ref.startsWith('/') || ref.endsWith('/') || ref.includes('..') || ref.includes('//')) {
    throw failure('INVALID_REF', 'ref must be a safe Git branch name');
  }

  const expectedHead = String(body.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(expectedHead)) throw failure('INVALID_EXPECTED_HEAD', 'expected_head must be an exact 40-character Git SHA');

  return { repo, workflow, ref, expected_head: expectedHead, inputs: normalizeInputs(body.inputs) };
}

function recentMatchingRun(runs, expectedHead, dispatchStartedAt) {
  const lowerBound = dispatchStartedAt - CREATION_SKEW_MS;
  return (Array.isArray(runs) ? runs : []).find((run) => {
    if (String(run?.head_sha || '').toLowerCase() !== expectedHead) return false;
    if (run?.event !== 'workflow_dispatch') return false;
    const created = Date.parse(String(run?.created_at || ''));
    return Number.isFinite(created) && created >= lowerBound;
  }) || null;
}

export async function dispatchGitHubWorkflowWithGitHubApp(input, options = {}) {
  const request = normalizeRequest(input);
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const [owner, name] = request.repo.split('/');
  const repoRoot = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const workflowPath = `${repoRoot}/actions/workflows/${encodeURIComponent(request.workflow)}`;

  return withApp(request.repo, async (apiClient) => {
    const preflight = await apiClient.call('github', {
      path: `${repoRoot}/git/ref/heads/${encodeURIComponent(request.ref)}`,
      method: 'GET',
    });
    if (preflight.status !== 200) githubFailure(preflight, 'workflow_dispatch.preflight');
    const observedHead = String(preflight.body?.object?.sha || '').toLowerCase();
    if (observedHead !== request.expected_head) {
      throw failure(
        'GITHUB_WORKFLOW_DISPATCH_HEAD_MISMATCH',
        'workflow dispatch branch head does not match expected_head',
        { ref: request.ref, expected_head: request.expected_head, observed_head: observedHead || null },
        { httpStatus: 409, mayHaveMutated: false },
      );
    }

    const dispatchStartedAt = Date.now();
    let dispatch;
    try {
      dispatch = await apiClient.call('github', {
        path: `${workflowPath}/dispatches`,
        method: 'POST',
        body: { ref: request.ref, inputs: request.inputs },
      });
    } catch (error) {
      throw failure(
        'GITHUB_WORKFLOW_DISPATCH_INDETERMINATE',
        `workflow dispatch transport failed: ${String(error?.message || error)}`,
        { workflow: request.workflow, ref: request.ref, expected_head: request.expected_head },
        { httpStatus: 502, mayHaveMutated: true },
      );
    }
    if (dispatch.status !== 200 && dispatch.status !== 204) {
      githubFailure(dispatch, 'workflow_dispatch.dispatch', { mayHaveMutated: false });
    }

    for (let attempt = 0; attempt < MAX_CONFIRM_ATTEMPTS; attempt += 1) {
      const runs = await apiClient.call('github', {
        path: `${workflowPath}/runs`,
        method: 'GET',
        query: { branch: request.ref, event: 'workflow_dispatch', per_page: 10 },
      });
      if (runs.status !== 200) {
        throw failure(
          'GITHUB_WORKFLOW_DISPATCH_IDENTITY_UNCONFIRMED',
          'workflow was dispatched but run identity could not be read back',
          { workflow: request.workflow, ref: request.ref, expected_head: request.expected_head, upstream_status: runs.status },
          { httpStatus: 502, mayHaveMutated: true },
        );
      }
      const run = recentMatchingRun(runs.body?.workflow_runs, request.expected_head, dispatchStartedAt);
      if (run) {
        return {
          ok: true,
          dispatched: true,
          repo: request.repo,
          workflow: request.workflow,
          ref: request.ref,
          expected_head: request.expected_head,
          workflow_run_id: Number(run.id) || null,
          workflow_run_head_sha: String(run.head_sha || '').toLowerCase() || null,
          workflow_run_status: run.status || null,
          workflow_run_conclusion: run.conclusion || null,
          workflow_run_html_url: run.html_url || null,
          precondition_verified: true,
          mutation_certainty: 'confirmed',
          may_have_mutated: true,
        };
      }
      if (attempt < MAX_CONFIRM_ATTEMPTS - 1) await sleep(CONFIRM_DELAY_MS);
    }

    throw failure(
      'GITHUB_WORKFLOW_DISPATCH_IDENTITY_UNCONFIRMED',
      'workflow was dispatched but no run at expected_head was observed',
      { workflow: request.workflow, ref: request.ref, expected_head: request.expected_head },
      { httpStatus: 409, mayHaveMutated: true },
    );
  }, { permissionProfile: 'workflow_dispatch' });
}

export { normalizeRequest as normalizeGitHubWorkflowDispatchRequest };