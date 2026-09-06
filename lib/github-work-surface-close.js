import { withGitHubAppApiClient } from 'lib/github-app-auth.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-f]{40}$/;

function fail(error, message, details = {}) { return { ok:false, error, message, ...details }; }
function encodeRepo(repo) { return repo.split('/').map(encodeURIComponent).join('/'); }

function normalizeBase(input, numberField) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_REQUEST', 'request must be an object', { may_have_mutated:false });
  const repo = String(input.repo || '').trim();
  const number = input[numberField];
  const artifactRef = String(input.artifact_ref || '').trim();
  if (!REPO.test(repo)) return fail('INVALID_REPOSITORY', 'repo must be owner/repo', { may_have_mutated:false });
  if (!Number.isInteger(number) || number < 1) return fail('INVALID_PROVIDER_IDENTITY', `${numberField} must be a positive integer`, { may_have_mutated:false });
  if (input.expected_state !== 'open') return fail('INVALID_EXPECTED_STATE', 'expected_state must be open', { may_have_mutated:false });
  if (!artifactRef) return fail('INVALID_ARTIFACT_REF', 'artifact_ref is required', { may_have_mutated:false });
  return { ok:true, repo, number, artifact_ref:artifactRef };
}

async function read(apiClient, path) {
  try {
    const response = await apiClient.call('github', { method:'GET', path, headers:{ Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10', 'User-Agent':'Overcenter/1.0' } });
    if (Number(response?.status || 0) !== 200) return fail('GITHUB_UPSTREAM_ERROR', `GitHub read returned HTTP ${response?.status || 'unknown'}`, { may_have_mutated:false, upstream_status:response?.status || null });
    return { ok:true, value:response.body || {} };
  } catch (error) {
    return fail('GITHUB_UPSTREAM_ERROR', String(error?.message || error), { may_have_mutated:false });
  }
}

async function closeAndReconcile(apiClient, path, observe, success) {
  let uncertain = false;
  try {
    const response = await apiClient.call('github', { method:'PATCH', path, body:{ state:'closed' }, headers:{ Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10', 'User-Agent':'Overcenter/1.0' } });
    if (Number(response?.status || 0) < 200 || Number(response?.status || 0) >= 300) uncertain = Number(response?.status || 0) >= 500;
  } catch { uncertain = true; }
  const after = await observe('post_mutation_verify');
  if (after.ok && after.closed) return success({ mutation_attempted:true, reconciled_after_indeterminate:uncertain });
  return fail('GITHUB_WORK_SURFACE_CLOSE_INDETERMINATE', 'The close mutation may have completed, but fresh authoritative readback did not prove the intended final state.', { may_have_mutated:true, reconciliation:after });
}

export async function closeGithubPullRequest(input, options = {}) {
  const base = normalizeBase(input, 'pull_request');
  if (!base.ok) return base;
  const expectedHead = String(input.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(expectedHead)) return fail('INVALID_SHA', 'expected_head must be a full Git SHA', { may_have_mutated:false });
  const apiClient = options.apiClient;
  if (!apiClient?.call) return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'GitHub transport is required', { may_have_mutated:false });
  const path = `/repos/${encodeRepo(base.repo)}/pulls/${base.number}`;
  const observe = async () => {
    const observed = await read(apiClient, path);
    if (!observed.ok) return observed;
    const pr = observed.value;
    if (Number(pr.number) !== base.number) return fail('GITHUB_PULL_REQUEST_IDENTITY_MISMATCH', 'GitHub returned a different pull request identity', { may_have_mutated:false });
    const head = String(pr.head?.sha || '').toLowerCase();
    if (head !== expectedHead) return fail('HEAD_MISMATCH', 'The pull request head does not match expected_head.', { expected_head:expectedHead, actual_head:head || null, may_have_mutated:false });
    return { ok:true, closed:String(pr.state).toLowerCase() === 'closed', merged:Boolean(pr.merged), head };
  };
  const before = await observe('preflight');
  if (!before.ok) return before;
  const success = (extra) => ({ ok:true, outcome:'closed', repo:base.repo, pull_request:base.number, expected_head:expectedHead, artifact_ref:base.artifact_ref, ...extra });
  if (before.closed) return { ...success({ mutation_attempted:false, reconciled_after_indeterminate:false }), outcome:'already_closed' };
  return closeAndReconcile(apiClient, path, observe, success);
}

export async function closeGithubIssue(input, options = {}) {
  const base = normalizeBase(input, 'issue');
  if (!base.ok) return base;
  const apiClient = options.apiClient;
  if (!apiClient?.call) return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'GitHub transport is required', { may_have_mutated:false });
  const path = `/repos/${encodeRepo(base.repo)}/issues/${base.number}`;
  const observe = async () => {
    const observed = await read(apiClient, path);
    if (!observed.ok) return observed;
    const issue = observed.value;
    if (Number(issue.number) !== base.number || issue.pull_request) return fail('GITHUB_ISSUE_IDENTITY_MISMATCH', 'GitHub returned a different issue identity or a pull request', { may_have_mutated:false });
    return { ok:true, closed:String(issue.state).toLowerCase() === 'closed' };
  };
  const before = await observe('preflight');
  if (!before.ok) return before;
  const success = (extra) => ({ ok:true, outcome:'closed', repo:base.repo, issue:base.number, artifact_ref:base.artifact_ref, ...extra });
  if (before.closed) return { ...success({ mutation_attempted:false, reconciled_after_indeterminate:false }), outcome:'already_closed' };
  return closeAndReconcile(apiClient, path, observe, success);
}

export async function closeGithubPullRequestWithGitHubApp(input, options = {}) {
  return (options.withGitHubAppApiClient || withGitHubAppApiClient)(input.repo, (apiClient) => closeGithubPullRequest(input, { ...options, apiClient }), { permissionProfile:'pull_request_close' });
}

export async function closeGithubIssueWithGitHubApp(input, options = {}) {
  return (options.withGitHubAppApiClient || withGitHubAppApiClient)(input.repo, (apiClient) => closeGithubIssue(input, { ...options, apiClient }), { permissionProfile:'issue_close' });
}