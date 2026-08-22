import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-fA-F]{40}$/;
const REF = /^(?!\/)(?!.*\.\.)(?!.*\/\/)(?!.*\.$)[A-Za-z0-9._\/-]+$/;

const ACTOR_QUERY = `
query GitHubPullRequestCreateActor($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      viewerCanUpdate
      viewerDidAuthor
    }
  }
}`;

function fail(error, message, details = null) {
  return { ok: false, error, message, ...(details && typeof details === 'object' ? details : {}) };
}

export function normalizeGithubPullRequestCreateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_REQUEST', 'request must be an object');
  const allowed = new Set(['repo', 'base', 'head', 'expected_base', 'expected_head', 'title', 'body', 'draft', 'run_id']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) return fail('INVALID_REQUEST', 'request contains unknown fields', { unknown });
  const repo = String(input.repo || '').trim();
  if (!REPO.test(repo)) return fail('INVALID_REPOSITORY', 'repo must be owner/repo');
  const base = String(input.base || '').trim();
  const head = String(input.head || '').trim();
  if (!REF.test(base)) return fail('INVALID_BASE_REF', 'base must be a repository branch name');
  if (!REF.test(head)) return fail('INVALID_HEAD_REF', 'head must be a repository branch name');
  const expectedBase = String(input.expected_base || '').trim().toLowerCase();
  const expectedHead = String(input.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(expectedBase)) return fail('INVALID_SHA', 'expected_base must be a full 40-character Git commit SHA');
  if (!SHA40.test(expectedHead)) return fail('INVALID_SHA', 'expected_head must be a full 40-character Git commit SHA');
  const title = String(input.title || '').trim();
  if (!title || title.length > 256) return fail('INVALID_TITLE', 'title must be between 1 and 256 characters');
  if (typeof input.draft !== 'boolean') return fail('INVALID_DRAFT', 'draft must be an explicit boolean');
  const body = input.body == null ? '' : String(input.body);
  if (body.length > 65536) return fail('INVALID_BODY', 'body is too large');
  return { ok: true, repo, base, head, expected_base: expectedBase, expected_head: expectedHead, title, body, draft: input.draft };
}

function publicPullRequest(pr) {
  return {
    pull_request: Number(pr?.number),
    state: String(pr?.state || '').toUpperCase(),
    draft: Boolean(pr?.draft),
    url: pr?.html_url ? String(pr.html_url) : null,
    author_login: pr?.user?.login ? String(pr.user.login) : null,
    head: pr?.head?.ref ? String(pr.head.ref) : null,
    head_sha: pr?.head?.sha ? String(pr.head.sha).toLowerCase() : null,
    base: pr?.base?.ref ? String(pr.base.ref) : null,
    base_sha: pr?.base?.sha ? String(pr.base.sha).toLowerCase() : null,
  };
}

function responseFailure(response, phase, mayHaveMutated = false) {
  const status = Number(response?.status || 0);
  const message = String(response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`);
  const evidence = githubTransportEvidence(response, { phase, attempts: 1, mayHaveMutated });
  if (status === 401 || status === 403) return fail('GITHUB_PERMISSION_DENIED', message, { upstream_status: status, ...evidence });
  if (status === 404) return fail('GITHUB_NOT_FOUND', message, { upstream_status: status, ...evidence });
  return fail(mayHaveMutated ? 'GITHUB_PULL_REQUEST_CREATE_INDETERMINATE' : 'GITHUB_UPSTREAM_ERROR', message, {
    ...(status ? { upstream_status: status } : {}),
    ...evidence,
  });
}

async function safeCall(apiClient, path, callOptions, options, phase) {
  try {
    const retried = await boundedSafeRead(
      () => apiClient.call('github', { path, ...callOptions }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
    const response = retried.response;
    if (!response || Number(response.status) < 200 || Number(response.status) >= 300) {
      const failure = responseFailure(response, phase, false);
      failure.attempts = retried.attempts;
      return failure;
    }
    return { ok: true, response, attempts: retried.attempts };
  } catch (error) {
    return fail('GITHUB_UPSTREAM_ERROR', String(error?.message || 'GitHub read failed.'), {
      phase,
      attempts: Number(error?.githubTransportAttempts || 1),
      may_have_mutated: false,
    });
  }
}

async function readBranchSha(apiClient, normalized, branch, options, phase) {
  const path = `/repos/${normalized.repo}/git/ref/heads/${encodeURIComponent(branch)}`;
  const read = await safeCall(apiClient, path, { method: 'GET' }, options, phase);
  if (!read.ok) return read;
  const sha = read.response?.body?.object?.sha;
  if (!SHA40.test(String(sha || ''))) return fail('GITHUB_INVALID_RESPONSE', 'GitHub branch response did not contain a commit SHA.', { phase, may_have_mutated: false });
  return { ok: true, sha: String(sha).toLowerCase() };
}

async function listOpenPullRequests(apiClient, normalized, options, phase) {
  const [owner] = normalized.repo.split('/');
  const path = `/repos/${normalized.repo}/pulls`;
  const read = await safeCall(apiClient, path, {
    method: 'GET',
    query: { state: 'open', head: `${owner}:${normalized.head}`, base: normalized.base, per_page: 100 },
  }, options, phase);
  if (!read.ok) return read;
  if (!Array.isArray(read.response?.body)) return fail('GITHUB_INVALID_RESPONSE', 'GitHub pull request list response was not an array.', { phase, may_have_mutated: false });
  const matches = read.response.body.filter((pr) => {
    const p = publicPullRequest(pr);
    return p.state === 'OPEN' && p.head === normalized.head && p.base === normalized.base && p.head_sha === normalized.expected_head;
  });
  if (matches.length > 1) return fail('GITHUB_PULL_REQUEST_CREATE_CONFLICT', 'More than one open pull request matched the exact head/base coordinate.', {
    phase,
    may_have_mutated: false,
    matching_pull_requests: matches.map((pr) => Number(pr.number)),
  });
  return { ok: true, pull: matches[0] || null };
}

async function readActorContinuity(apiClient, normalized, pullNumber, options = {}) {
  if (typeof apiClient.graphql !== 'function') return { available: false, reason: 'graphql_transport_unavailable' };
  const [owner, name] = normalized.repo.split('/');
  try {
    const retried = await boundedSafeRead(
      () => apiClient.graphql(ACTOR_QUERY, { owner, name, number: pullNumber }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
    const response = retried.response;
    const pr = response?.body?.data?.repository?.pullRequest;
    if (!response || Number(response.status) < 200 || Number(response.status) >= 300 || !pr || Array.isArray(response?.body?.errors) && response.body.errors.length) {
      return { available: false, reason: 'github_actor_read_failed', attempts: retried.attempts };
    }
    return {
      available: true,
      viewer_can_update: Boolean(pr.viewerCanUpdate),
      viewer_did_author: Boolean(pr.viewerDidAuthor),
      attempts: retried.attempts,
    };
  } catch (error) {
    return { available: false, reason: String(error?.message || 'github_actor_read_failed') };
  }
}

async function successForPull(apiClient, normalized, pr, outcome, options, extra = {}) {
  const publicPr = publicPullRequest(pr);
  const continuity = await readActorContinuity(apiClient, normalized, publicPr.pull_request, options);
  return {
    ok: true,
    outcome,
    repo: normalized.repo,
    pull_request: publicPr.pull_request,
    expected_base: normalized.expected_base,
    expected_head: normalized.expected_head,
    base: normalized.base,
    head: normalized.head,
    state: publicPr.state,
    draft: publicPr.draft,
    url: publicPr.url,
    author_login: publicPr.author_login,
    actor_continuity: continuity,
    ...extra,
  };
}

async function reconcileAfterCreate(apiClient, normalized, options, mutationEvidence, outcome = 'created') {
  const observed = await listOpenPullRequests(apiClient, normalized, options, 'reconcile_after_indeterminate');
  if (!observed.ok) {
    return fail('GITHUB_PULL_REQUEST_CREATE_INDETERMINATE', 'The pull-request creation lost transport certainty and authoritative reconciliation could not complete.', {
      phase: 'reconcile_after_indeterminate',
      may_have_mutated: true,
      mutation_evidence: mutationEvidence,
      reconciliation_error: observed,
    });
  }
  if (!observed.pull) {
    return fail('GITHUB_PULL_REQUEST_CREATE_INDETERMINATE', 'The pull-request creation may have completed, but authoritative state does not prove the intended pull request exists.', {
      phase: 'reconcile_after_indeterminate',
      may_have_mutated: true,
      mutation_evidence: mutationEvidence,
    });
  }
  return successForPull(apiClient, normalized, observed.pull, outcome, options, {
    mutation_attempted: true,
    reconciled_after_indeterminate: true,
    mutation_evidence: mutationEvidence,
  });
}

export async function createGithubPullRequest(input, options = {}) {
  const normalized = normalizeGithubPullRequestCreateRequest(input);
  if (!normalized.ok) return normalized;
  const apiClient = options.apiClient;
  if (!apiClient || typeof apiClient.call !== 'function') return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub REST transport is required.');

  const base = await readBranchSha(apiClient, normalized, normalized.base, options, 'preflight_base');
  if (!base.ok) return base;
  if (base.sha !== normalized.expected_base) return fail('BASE_MISMATCH', 'The base branch does not match expected_base.', {
    expected_base: normalized.expected_base,
    actual_base: base.sha,
    phase: 'preflight',
    may_have_mutated: false,
  });
  const head = await readBranchSha(apiClient, normalized, normalized.head, options, 'preflight_head');
  if (!head.ok) return head;
  if (head.sha !== normalized.expected_head) return fail('HEAD_MISMATCH', 'The head branch does not match expected_head.', {
    expected_head: normalized.expected_head,
    actual_head: head.sha,
    phase: 'preflight',
    may_have_mutated: false,
  });

  const existing = await listOpenPullRequests(apiClient, normalized, options, 'preflight_existing_pull_request');
  if (!existing.ok) return existing;
  if (existing.pull) return successForPull(apiClient, normalized, existing.pull, 'already_exists', options, { mutation_attempted: false });

  let mutationResponse;
  try {
    mutationResponse = await apiClient.call('github', {
      path: `/repos/${normalized.repo}/pulls`,
      method: 'POST',
      body: { title: normalized.title, head: normalized.head, base: normalized.base, body: normalized.body, draft: normalized.draft },
    });
  } catch (error) {
    return reconcileAfterCreate(apiClient, normalized, options, {
      phase: 'create_pull_request',
      transport_error: String(error?.message || error),
      may_have_mutated: true,
    });
  }

  const status = Number(mutationResponse?.status || 0);
  if (!mutationResponse || status < 200 || status >= 300) {
    if (status === 422 || status >= 500) {
      const reconciled = await reconcileAfterCreate(apiClient, normalized, options, responseFailure(mutationResponse, 'create_pull_request', true), status === 422 ? 'already_exists' : 'created');
      if (reconciled.ok || reconciled.error === 'GITHUB_PULL_REQUEST_CREATE_INDETERMINATE') return reconciled;
    }
    return responseFailure(mutationResponse, 'create_pull_request', false);
  }

  const observed = await listOpenPullRequests(apiClient, normalized, options, 'post_create_verify');
  if (!observed.ok || !observed.pull) {
    return fail('GITHUB_PULL_REQUEST_CREATE_INDETERMINATE', 'GitHub acknowledged pull-request creation, but authoritative verification could not prove the exact pull request.', {
      phase: 'post_create_verify',
      may_have_mutated: true,
      verification_error: observed.ok ? null : observed,
      create_response_pull_request: Number(mutationResponse?.body?.number || 0) || null,
    });
  }
  return successForPull(apiClient, normalized, observed.pull, 'created', options, {
    mutation_attempted: true,
    reconciled_after_indeterminate: false,
  });
}

function mapAuthError(error) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  if (/config\/get 412|declared as required but not set/i.test(message)) {
    return fail('GITHUB_APP_SETUP_REQUIRED', 'Configure the GitHub App ID and private key before creating pull requests.');
  }
  if ([401, 403, 422].includes(Number(error?.status))) {
    return fail('GITHUB_APP_PERMISSION_DENIED', message, { upstream_status: Number(error.status), required_permissions: { contents: 'read', pull_requests: 'write' } });
  }
  if (Number(error?.status) === 404) return fail('GITHUB_APP_INSTALLATION_NOT_FOUND', 'The GitHub App is not installed for this repository.', { upstream_status: 404 });
  return fail(error?.code || 'GITHUB_APP_AUTH_ERROR', message, error?.status ? { upstream_status: Number(error.status) } : null);
}

export async function createGithubPullRequestWithGitHubApp(input, options = {}) {
  const normalized = normalizeGithubPullRequestCreateRequest(input);
  if (!normalized.ok) return normalized;
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  try {
    return await withApp(normalized.repo, async (apiClient) => createGithubPullRequest({
      repo: normalized.repo,
      base: normalized.base,
      head: normalized.head,
      expected_base: normalized.expected_base,
      expected_head: normalized.expected_head,
      title: normalized.title,
      body: normalized.body,
      draft: normalized.draft,
    }, { ...options, apiClient }), {
      permissionProfile: 'pull_request_create',
    });
  } catch (error) {
    return mapAuthError(error);
  }
}