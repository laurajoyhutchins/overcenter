import { boundedSafeRead, githubTransportEvidence } from './github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-fA-F]{40}$/;

function fail(error, message, details = null) {
  return { ok:false, error, message, ...(details && typeof details === 'object' ? details : {}) };
}

function normalizeCommon(input, numberField) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_REQUEST', 'request must be an object');
  const allowed = new Set(['repo', numberField, 'expected_state', 'run_id', ...(numberField === 'pull_request' ? ['expected_head'] : [])]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) return fail('INVALID_REQUEST', 'request contains unknown fields', { unknown });
  const repo = String(input.repo || '').trim();
  if (!REPO.test(repo)) return fail('INVALID_REPOSITORY', 'repo must be owner/repo');
  if (!Number.isInteger(input[numberField]) || input[numberField] <= 0) return fail(`INVALID_${numberField.toUpperCase()}`, `${numberField} must be a positive integer`);
  if (input.expected_state !== 'open') return fail('INVALID_EXPECTED_STATE', 'expected_state must be open');
  return { ok:true, repo, [numberField]:input[numberField], expected_state:'open' };
}

export function normalizeGithubIssueCloseRequest(input) {
  return normalizeCommon(input, 'issue');
}

export function normalizeGithubPullRequestCloseRequest(input) {
  const normalized = normalizeCommon(input, 'pull_request');
  if (!normalized.ok) return normalized;
  const expectedHead = String(input.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(expectedHead)) return fail('INVALID_SHA', 'expected_head must be a full 40-character Git commit SHA');
  return { ...normalized, expected_head:expectedHead };
}

function pathFor(normalized, kind) {
  const [owner, name] = normalized.repo.split('/').map(encodeURIComponent);
  const number = kind === 'issue' ? normalized.issue : normalized.pull_request;
  return `/repos/${owner}/${name}/${kind === 'issue' ? 'issues' : 'pulls'}/${number}`;
}

function responseFailure(response, phase, kind, mayHaveMutated = false) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const evidence = githubTransportEvidence(response, { phase, path:kind === 'issue' ? '/issues/{number}' : '/pulls/{number}', attempts:1, mayHaveMutated });
  if (status === 401 || status === 403) return fail('GITHUB_PERMISSION_DENIED', message, { upstream_status:status, ...evidence });
  if (status === 404) return fail('GITHUB_NOT_FOUND', message, { upstream_status:status, ...evidence });
  return fail(mayHaveMutated ? `GITHUB_${kind.toUpperCase()}_CLOSE_INDETERMINATE` : 'GITHUB_UPSTREAM_ERROR', message, { ...(status ? { upstream_status:status } : {}), ...evidence });
}

async function readSurface(apiClient, normalized, kind, options = {}, phase = 'preflight') {
  const path = pathFor(normalized, kind);
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.call('github', { method:'GET', path, headers:{ Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10', 'User-Agent':'Overcenter/1.0' } }),
      { sleep:options.sleep, random:options.random, maxAttempts:options.maxAttempts || 3 },
    );
  } catch (error) {
    return fail('GITHUB_UPSTREAM_ERROR', String(error?.message || 'GitHub work-surface read failed'), { phase, attempts:Number(error?.githubTransportAttempts || 1), may_have_mutated:false });
  }
  const response = retried.response;
  if (!response || response.status < 200 || response.status >= 300) {
    const failure = responseFailure(response, phase, kind, false);
    failure.attempts = retried.attempts;
    return failure;
  }
  const body = response.body || {};
  const expectedNumber = kind === 'issue' ? normalized.issue : normalized.pull_request;
  if (Number(body.number) !== expectedNumber) return fail('GITHUB_IDENTITY_MISMATCH', 'GitHub readback returned a different numeric work-surface identity', { phase, expected_number:expectedNumber, actual_number:Number(body.number) || null, may_have_mutated:false });
  if (kind === 'issue' && body.pull_request) return fail('GITHUB_ISSUE_IDENTITY_MISMATCH', 'github.issue.close refuses pull requests exposed through the issues API', { phase, issue:normalized.issue, may_have_mutated:false });
  return {
    ok:true,
    number:expectedNumber,
    state:String(body.state || '').toLowerCase(),
    head_sha:kind === 'pull_request' ? String(body.head?.sha || '').toLowerCase() || null : null,
    url:body.html_url ? String(body.html_url) : null,
    attempts:retried.attempts,
  };
}

function success(normalized, kind, observed, outcome, extra = {}) {
  return {
    ok:true,
    outcome,
    repo:normalized.repo,
    ...(kind === 'issue' ? { issue:normalized.issue } : { pull_request:normalized.pull_request, expected_head:normalized.expected_head }),
    expected_state:normalized.expected_state,
    state:observed.state,
    url:observed.url,
    mutation_certainty:'confirmed',
    may_have_mutated:Boolean(extra.mutation_attempted),
    ...extra,
  };
}

function headMismatch(normalized, observed, mayHaveMutated = false) {
  return fail('HEAD_MISMATCH', 'The pull request head does not match expected_head', {
    expected_head:normalized.expected_head,
    actual_head:observed.head_sha,
    phase:mayHaveMutated ? 'post_mutation_verify' : 'preflight',
    may_have_mutated:mayHaveMutated,
  });
}

async function reconcileAfterUncertainMutation(apiClient, normalized, kind, options, mutationEvidence) {
  const observed = await readSurface(apiClient, normalized, kind, options, 'reconcile_after_indeterminate');
  const code = `GITHUB_${kind.toUpperCase()}_CLOSE_INDETERMINATE`;
  if (!observed.ok) return fail(code, 'Closure lost transport certainty and authoritative reconciliation could not complete', { phase:'reconcile_after_indeterminate', may_have_mutated:true, mutation_evidence:mutationEvidence, reconciliation_error:observed });
  if (kind === 'pull_request' && observed.head_sha !== normalized.expected_head) return fail(code, 'Closure may have completed across a pull request head change', { phase:'reconcile_after_indeterminate', may_have_mutated:true, expected_head:normalized.expected_head, actual_head:observed.head_sha, mutation_evidence:mutationEvidence });
  if (observed.state === 'closed') return success(normalized, kind, observed, 'closed', { mutation_attempted:true, reconciled_after_indeterminate:true, mutation_evidence:mutationEvidence, may_have_mutated:true });
  return fail(code, 'Closure may have completed, but authoritative state does not prove the intended final state', { phase:'reconcile_after_indeterminate', may_have_mutated:true, observed_state:observed.state, mutation_evidence:mutationEvidence });
}

async function closeSurface(input, kind, options = {}) {
  const normalized = kind === 'issue' ? normalizeGithubIssueCloseRequest(input) : normalizeGithubPullRequestCloseRequest(input);
  if (!normalized.ok) return normalized;
  const apiClient = options.apiClient;
  if (!apiClient || typeof apiClient.call !== 'function') return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub API transport is required');

  const before = await readSurface(apiClient, normalized, kind, options, 'preflight');
  if (!before.ok) return before;
  if (kind === 'pull_request' && before.head_sha !== normalized.expected_head) return headMismatch(normalized, before, false);
  if (before.state === 'closed') return success(normalized, kind, before, 'already_closed', { mutation_attempted:false, reconciled_after_indeterminate:false, may_have_mutated:false });
  if (before.state !== normalized.expected_state) return fail('GITHUB_STATE_MISMATCH', 'Work surface does not match expected_state', { expected_state:normalized.expected_state, actual_state:before.state, may_have_mutated:false });

  const path = pathFor(normalized, kind);
  let mutationResponse;
  try {
    mutationResponse = await apiClient.call('github', { method:'PATCH', path, body:{ state:'closed' }, headers:{ Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10', 'User-Agent':'Overcenter/1.0' } });
  } catch (error) {
    return reconcileAfterUncertainMutation(apiClient, normalized, kind, options, { phase:'close', transport_error:String(error?.message || error), may_have_mutated:true });
  }
  const status = Number(mutationResponse?.status || 0);
  if (!mutationResponse || status < 200 || status >= 300) {
    const uncertain = status >= 500 || status === 0;
    const failure = responseFailure(mutationResponse, 'close', kind, uncertain);
    if (uncertain) return reconcileAfterUncertainMutation(apiClient, normalized, kind, options, failure);
    return failure;
  }

  const after = await readSurface(apiClient, normalized, kind, options, 'post_mutation_verify');
  const code = `GITHUB_${kind.toUpperCase()}_CLOSE_INDETERMINATE`;
  if (!after.ok) return fail(code, 'GitHub acknowledged closure, but authoritative verification could not complete', { phase:'post_mutation_verify', may_have_mutated:true, verification_error:after });
  if (kind === 'pull_request' && after.head_sha !== normalized.expected_head) return fail(code, 'Closure completed across a pull request head change', { phase:'post_mutation_verify', may_have_mutated:true, expected_head:normalized.expected_head, actual_head:after.head_sha, observed_state:after.state });
  if (after.state !== 'closed') return fail(code, 'GitHub acknowledged closure but fresh readback did not expose closed state', { phase:'post_mutation_verify', may_have_mutated:true, observed_state:after.state });
  return success(normalized, kind, after, 'closed', { mutation_attempted:true, reconciled_after_indeterminate:false, may_have_mutated:true });
}

export function closeGithubIssue(input, options = {}) { return closeSurface(input, 'issue', options); }
export function closeGithubPullRequest(input, options = {}) { return closeSurface(input, 'pull_request', options); }

// GitHub App authentication is bound by the host adapter, not the provider-neutral core.