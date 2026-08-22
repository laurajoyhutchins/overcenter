import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { boundedSafeRead, githubTransportEvidence } from 'lib/github-transport.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-fA-F]{40}$/;

const PR_QUERY = `
query GitHubPullRequestReadyPreflight($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    pullRequest(number: $number) {
      id
      number
      state
      isDraft
      merged
      headRefOid
      viewerCanUpdate
      viewerDidAuthor
      url
    }
  }
}`;

const MARK_READY_MUTATION = `
mutation GitHubMarkPullRequestReady($input: MarkPullRequestReadyForReviewInput!) {
  markPullRequestReadyForReview(input: $input) {
    clientMutationId
    pullRequest {
      id
      number
      state
      isDraft
      merged
      headRefOid
      url
    }
  }
}`;

function fail(error, message, details = null) {
  return { ok: false, error, message, ...(details && typeof details === 'object' ? details : {}) };
}

export function normalizeGithubPullRequestReadyRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_REQUEST', 'request must be an object');
  const allowed = new Set(['repo', 'pull_request', 'expected_head', 'run_id']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) return fail('INVALID_REQUEST', 'request contains unknown fields', { unknown });
  const repo = String(input.repo || '').trim();
  if (!REPO.test(repo)) return fail('INVALID_REPOSITORY', 'repo must be owner/repo');
  if (!Number.isInteger(input.pull_request) || input.pull_request <= 0) return fail('INVALID_PULL_REQUEST', 'pull_request must be a positive integer');
  const expectedHead = String(input.expected_head || '').trim().toLowerCase();
  if (!SHA40.test(expectedHead)) return fail('INVALID_SHA', 'expected_head must be a full 40-character Git commit SHA');
  return { ok: true, repo, pull_request: input.pull_request, expected_head: expectedHead };
}

function graphqlErrors(response) {
  return Array.isArray(response?.body?.errors) ? response.body.errors : [];
}

function summarizeErrors(errors) {
  return errors.map((error) => ({
    message: String(error?.message || 'GitHub GraphQL error'),
    ...(error?.type ? { type: String(error.type) } : {}),
    ...(Array.isArray(error?.path) ? { path: error.path } : {}),
  }));
}

function responseFailure(response, phase, mayHaveMutated = false) {
  const status = Number(response?.status || 0);
  const errors = graphqlErrors(response);
  const summaries = summarizeErrors(errors);
  const message = summaries[0]?.message || response?.body?.message || `GitHub returned HTTP ${status || 'unknown'}`;
  const forbidden = status === 401 || status === 403 || errors.some((error) => String(error?.type || '').toUpperCase() === 'FORBIDDEN');
  const notFound = status === 404 || errors.some((error) => /could not resolve|not found/i.test(String(error?.message || '')));
  const evidence = githubTransportEvidence(response, { phase, path: '/graphql', attempts: 1, mayHaveMutated });
  if (forbidden) return fail('GITHUB_PERMISSION_DENIED', String(message), { upstream_status: status || null, graphql_errors: summaries, ...evidence });
  if (notFound) return fail('GITHUB_NOT_FOUND', String(message), { upstream_status: status || null, graphql_errors: summaries, ...evidence });
  return fail(mayHaveMutated ? 'GITHUB_PULL_REQUEST_READY_INDETERMINATE' : 'GITHUB_UPSTREAM_ERROR', String(message), {
    ...(status ? { upstream_status: status } : {}),
    graphql_errors: summaries,
    ...evidence,
  });
}

function publicPullRequest(pr) {
  return {
    id: String(pr.id),
    number: Number(pr.number),
    state: String(pr.state || '').toUpperCase(),
    draft: Boolean(pr.isDraft),
    merged: Boolean(pr.merged),
    head_sha: pr.headRefOid ? String(pr.headRefOid).toLowerCase() : null,
    viewer_can_update: Boolean(pr.viewerCanUpdate),
    viewer_did_author: Boolean(pr.viewerDidAuthor),
    url: pr.url ? String(pr.url) : null,
  };
}

async function readPullRequest(apiClient, normalized, options = {}, phase = 'preflight') {
  const [owner, name] = normalized.repo.split('/');
  let retried;
  try {
    retried = await boundedSafeRead(
      () => apiClient.graphql(PR_QUERY, { owner, name, number: normalized.pull_request }),
      { sleep: options.sleep, random: options.random, maxAttempts: options.maxAttempts || 3 },
    );
  } catch (error) {
    return fail('GITHUB_UPSTREAM_ERROR', String(error?.message || 'GitHub pull request read failed.'), {
      phase,
      github_path: '/graphql',
      attempts: Number(error?.githubTransportAttempts || 1),
      may_have_mutated: false,
    });
  }
  const response = retried.response;
  if (!response || response.status < 200 || response.status >= 300 || graphqlErrors(response).length) {
    const failure = responseFailure(response, phase, false);
    failure.attempts = retried.attempts;
    return failure;
  }
  const repository = response.body?.data?.repository;
  const pr = repository?.pullRequest;
  if (!repository?.id || !pr?.id) return fail('GITHUB_NOT_FOUND', 'The repository or pull request was not found.', { phase, may_have_mutated: false });
  return { ok: true, ...publicPullRequest(pr), attempts: retried.attempts };
}

function exactHeadFailure(normalized, observed, mayHaveMutated = false) {
  return fail('HEAD_MISMATCH', 'The pull request head does not match expected_head.', {
    expected_head: normalized.expected_head,
    actual_head: observed.head_sha,
    phase: mayHaveMutated ? 'post_mutation_verify' : 'preflight',
    may_have_mutated: mayHaveMutated,
  });
}

function success(normalized, observed, outcome, extra = {}) {
  return {
    ok: true,
    outcome,
    repo: normalized.repo,
    pull_request: normalized.pull_request,
    expected_head: normalized.expected_head,
    state: observed.state,
    draft: observed.draft,
    merged: observed.merged,
    url: observed.url,
    ...extra,
  };
}

async function reconcileAfterUncertainMutation(apiClient, normalized, options, mutationEvidence) {
  const observed = await readPullRequest(apiClient, normalized, options, 'reconcile_after_indeterminate');
  if (!observed.ok) {
    return fail('GITHUB_PULL_REQUEST_READY_INDETERMINATE', 'The ready-for-review mutation lost transport certainty and authoritative reconciliation could not complete.', {
      phase: 'reconcile_after_indeterminate',
      may_have_mutated: true,
      mutation_evidence: mutationEvidence,
      reconciliation_error: observed,
    });
  }
  if (observed.head_sha !== normalized.expected_head) {
    return fail('GITHUB_PULL_REQUEST_READY_INDETERMINATE', 'The ready-for-review mutation may have completed, but the pull request head changed before reconciliation.', {
      phase: 'reconcile_after_indeterminate',
      may_have_mutated: true,
      expected_head: normalized.expected_head,
      actual_head: observed.head_sha,
      observed_draft: observed.draft,
      mutation_evidence: mutationEvidence,
    });
  }
  if (observed.state === 'OPEN' && observed.draft === false) {
    return success(normalized, observed, 'marked_ready', {
      mutation_attempted: true,
      reconciled_after_indeterminate: true,
      mutation_evidence: mutationEvidence,
    });
  }
  return fail('GITHUB_PULL_REQUEST_READY_INDETERMINATE', 'The ready-for-review mutation may have completed, but authoritative state does not prove the intended final state.', {
    phase: 'reconcile_after_indeterminate',
    may_have_mutated: true,
    observed_state: observed.state,
    observed_draft: observed.draft,
    mutation_evidence: mutationEvidence,
  });
}

export async function markGithubPullRequestReady(input, options = {}) {
  const normalized = normalizeGithubPullRequestReadyRequest(input);
  if (!normalized.ok) return normalized;
  const apiClient = options.apiClient;
  if (!apiClient || typeof apiClient.graphql !== 'function') return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub GraphQL transport is required.');

  const before = await readPullRequest(apiClient, normalized, options, 'preflight');
  if (!before.ok) return before;
  if (before.head_sha !== normalized.expected_head) return exactHeadFailure(normalized, before, false);
  if (before.merged) return success(normalized, before, 'already_merged', { mutation_attempted: false });
  if (before.state !== 'OPEN') return fail('GITHUB_PULL_REQUEST_CLOSED', 'Only an open pull request can be marked ready for review.', { state: before.state, may_have_mutated: false });
  if (!before.draft) return success(normalized, before, 'already_ready', { mutation_attempted: false });
  if (!before.viewer_can_update && !before.viewer_did_author) {
    return fail('GITHUB_PULL_REQUEST_READY_ACTOR_UNAUTHORIZED', 'GitHub does not authorize this installation actor to mark the pull request ready for review.', {
      phase: 'preflight',
      may_have_mutated: false,
      authorization: {
        viewer_can_update: before.viewer_can_update,
        viewer_did_author: before.viewer_did_author,
      },
    });
  }

  let mutationResponse;
  try {
    mutationResponse = await apiClient.graphql(MARK_READY_MUTATION, {
      input: { pullRequestId: before.id, clientMutationId: `mark-ready:${normalized.pull_request}:${normalized.expected_head}` },
    });
  } catch (error) {
    return reconcileAfterUncertainMutation(apiClient, normalized, options, {
      phase: 'mark_ready',
      transport_error: String(error?.message || error),
      may_have_mutated: true,
    });
  }

  const mutationErrors = graphqlErrors(mutationResponse);
  const mutationStatus = Number(mutationResponse?.status || 0);
  if (!mutationResponse || mutationStatus < 200 || mutationStatus >= 300 || mutationErrors.length) {
    const hasMutationData = Boolean(mutationResponse?.body?.data?.markPullRequestReadyForReview?.pullRequest?.id);
    const failure = responseFailure(mutationResponse, 'mark_ready', hasMutationData || (mutationStatus >= 500 && mutationStatus <= 599));
    if (failure.error === 'GITHUB_PULL_REQUEST_READY_INDETERMINATE') {
      return reconcileAfterUncertainMutation(apiClient, normalized, options, failure);
    }
    return {
      ...failure,
      authorization: {
        viewer_can_update: before.viewer_can_update,
        viewer_did_author: before.viewer_did_author,
      },
    };
  }

  const after = await readPullRequest(apiClient, normalized, options, 'post_mutation_verify');
  if (!after.ok) {
    return fail('GITHUB_PULL_REQUEST_READY_INDETERMINATE', 'GitHub acknowledged the ready-for-review mutation, but authoritative verification could not complete.', {
      phase: 'post_mutation_verify',
      may_have_mutated: true,
      verification_error: after,
    });
  }
  if (after.head_sha !== normalized.expected_head) {
    return fail('GITHUB_PULL_REQUEST_READY_INDETERMINATE', 'The ready-for-review mutation completed across a pull request head change; exact-head verification must be refreshed.', {
      phase: 'post_mutation_verify',
      may_have_mutated: true,
      expected_head: normalized.expected_head,
      actual_head: after.head_sha,
      observed_state: after.state,
      observed_draft: after.draft,
    });
  }
  if (after.state !== 'OPEN' || after.draft !== false) {
    return fail('GITHUB_PULL_REQUEST_READY_INDETERMINATE', 'GitHub acknowledged the ready-for-review mutation but did not expose the intended authoritative final state.', {
      phase: 'post_mutation_verify',
      may_have_mutated: true,
      observed_state: after.state,
      observed_draft: after.draft,
    });
  }
  return success(normalized, after, 'marked_ready', { mutation_attempted: true, reconciled_after_indeterminate: false });
}

function mapAuthError(error) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  if (/config\/get 412|declared as required but not set/i.test(message)) {
    return fail('GITHUB_APP_SETUP_REQUIRED', 'Configure the GitHub App ID and private key before marking pull requests ready for review.');
  }
  if ([401, 403, 422].includes(Number(error?.status))) {
    return fail('GITHUB_APP_PERMISSION_DENIED', message, { upstream_status: Number(error.status), required_permissions: { contents: 'write', pull_requests: 'write' } });
  }
  if (Number(error?.status) === 404) return fail('GITHUB_APP_INSTALLATION_NOT_FOUND', 'The GitHub App is not installed for this repository.', { upstream_status: 404 });
  return fail(error?.code || 'GITHUB_APP_AUTH_ERROR', message, error?.status ? { upstream_status: Number(error.status) } : null);
}

export async function markGithubPullRequestReadyWithGitHubApp(input, options = {}) {
  const normalized = normalizeGithubPullRequestReadyRequest(input);
  if (!normalized.ok) return normalized;
  const withApp = options.withGitHubAppApiClient || withGitHubAppApiClient;
  try {
    return await withApp(normalized.repo, async (apiClient) => markGithubPullRequestReady({
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
    }, { ...options, apiClient }), {
      permissionProfile: 'pull_request_mark_ready',
    });
  } catch (error) {
    return mapAuthError(error);
  }
}