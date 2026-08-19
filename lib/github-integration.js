import { withGitHubAppApiClient } from 'lib/github-app-auth.js';
import { reviewGithubPullRequestWithGitHubApp } from 'lib/github-review-packet.js';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA40 = /^[0-9a-fA-F]{40}$/;
const MERGE_UUID = /^[A-Za-z0-9-]{8,128}$/;

function fail(code, message, details = null) {
  return { ok: false, error: code, message, ...(details && typeof details === 'object' ? details : {}) };
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('INVALID_REQUEST', 'request must be an object');
  const allowed = new Set(['repo', 'pull_request', 'expected_head', 'apply', 'merge_request_uuid']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) return fail('INVALID_REQUEST', 'request contains unknown fields', { unknown });
  const repo = String(input.repo || '').trim();
  if (!REPO.test(repo)) return fail('INVALID_REPOSITORY', 'repo must be owner/repo');
  if (!Number.isInteger(input.pull_request) || input.pull_request <= 0) return fail('INVALID_PULL_REQUEST', 'pull_request must be a positive integer');
  const expectedHead = String(input.expected_head || '').toLowerCase();
  if (!SHA40.test(expectedHead)) return fail('INVALID_SHA', 'expected_head must be a full 40-character Git commit SHA');
  if (input.apply !== undefined && typeof input.apply !== 'boolean') return fail('INVALID_REQUEST', 'apply must be boolean');
  let mergeRequestUuid = null;
  if (input.merge_request_uuid !== undefined && input.merge_request_uuid !== null) {
    mergeRequestUuid = String(input.merge_request_uuid).trim();
    if (!MERGE_UUID.test(mergeRequestUuid)) return fail('INVALID_REQUEST', 'merge_request_uuid is invalid');
  }
  return {
    ok: true,
    repo,
    pull_request: input.pull_request,
    expected_head: expectedHead,
    apply: Boolean(input.apply),
    merge_request_uuid: mergeRequestUuid,
  };
}

function pathFor(repo, pullRequest, suffix = '') {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pullRequest}${suffix}`;
}

function upstreamMessage(body, fallback) {
  if (body && typeof body === 'object' && body.message) return String(body.message);
  if (typeof body === 'string' && body.trim()) return body.trim();
  return fallback;
}

function detailsFromAsync(body) {
  const details = body && typeof body === 'object' && body.details && typeof body.details === 'object'
    ? body.details : {};
  return {
    status: body?.status ? String(body.status) : null,
    uuid: details.uuid ? String(details.uuid) : null,
    sha: details.sha ? String(details.sha).toLowerCase() : null,
    message: details.message ? String(details.message) : null,
    expected_head_sha: details.expected_head_sha ? String(details.expected_head_sha).toLowerCase() : null,
    merge_method: details.merge_method ? String(details.merge_method) : null,
    merge_action: details.merge_action ? String(details.merge_action) : null,
  };
}

export function createGithubIntegrationApiAdapter(apiClient) {
  if (!apiClient || typeof apiClient.call !== 'function') throw new Error('A GitHub API transport is required.');

  async function call(method, path, body) {
    return apiClient.call('github', {
      method,
      path,
      ...(body === undefined ? {} : { body }),
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10',
        'User-Agent': 'Hatchable-Portfolio-Control-Plane/1.0',
      },
    });
  }

  return {
    async updateBranch({ repo, pull_request, expected_head }) {
      const path = pathFor(repo, pull_request, '/update-branch');
      let response;
      try {
        response = await call('PUT', path, { expected_head_sha: expected_head });
      } catch (error) {
        return fail('GITHUB_INTEGRATION_INDETERMINATE', 'The update-branch request lost transport certainty; re-read the PR before retrying.', {
          phase: 'update_branch',
          may_have_mutated: true,
          github_message: String(error?.message || error),
        });
      }
      const status = Number(response?.status || 0);
      if (status === 202) {
        return { ok: true, status, message: upstreamMessage(response.body, 'Updating pull request branch.') };
      }
      if (status === 422 || status === 409) {
        return fail('GITHUB_INTEGRATION_RECOMPUTE_REQUIRED', 'The pull request head or base changed before GitHub could update the branch.', {
          upstream_status: status,
          github_message: upstreamMessage(response?.body, 'GitHub rejected the branch update.'),
        });
      }
      return fail(status === 403 ? 'GITHUB_APP_PERMISSION_DENIED' : 'GITHUB_UPSTREAM_ERROR',
        upstreamMessage(response?.body, `GitHub returned HTTP ${status || 'unknown'}`), { upstream_status: status || null });
    },

    async mergeAsync({ repo, pull_request, expected_head, merge_method = 'squash', merge_action = 'direct_merge' }) {
      const path = pathFor(repo, pull_request, '/merge-async');
      let response;
      try {
        response = await call('PUT', path, {
          sha: expected_head,
          merge_method,
          merge_action,
        });
      } catch (error) {
        return fail('GITHUB_INTEGRATION_INDETERMINATE', 'The asynchronous merge request lost transport certainty; reconcile GitHub state before retrying.', {
          phase: 'merge_async',
          may_have_mutated: true,
          github_message: String(error?.message || error),
        });
      }
      const status = Number(response?.status || 0);
      const asyncDetails = detailsFromAsync(response?.body);
      if ([200, 202].includes(status)) {
        return { ok: true, http_status: status, ...asyncDetails };
      }
      if (status === 409 && asyncDetails.uuid) {
        return { ok: true, http_status: status, status: asyncDetails.status || 'pending', existing_request: true, ...asyncDetails };
      }
      if (status === 409 || status === 422) {
        return fail('GITHUB_INTEGRATION_RECOMPUTE_REQUIRED', 'GitHub rejected the exact-head asynchronous merge request because repository state changed.', {
          upstream_status: status,
          github_message: upstreamMessage(response?.body, 'GitHub rejected the asynchronous merge.'),
        });
      }
      if (status === 400 || status === 405) {
        return fail('GITHUB_INTEGRATION_NOT_READY', upstreamMessage(response?.body, 'GitHub reports the pull request is not ready to merge.'), {
          upstream_status: status,
        });
      }
      return fail(status === 403 ? 'GITHUB_APP_PERMISSION_DENIED' : 'GITHUB_UPSTREAM_ERROR',
        upstreamMessage(response?.body, `GitHub returned HTTP ${status || 'unknown'}`), { upstream_status: status || null });
    },

    async getMergeResult({ repo, pull_request, merge_request_uuid }) {
      const path = pathFor(repo, pull_request, `/merge-async/${encodeURIComponent(merge_request_uuid)}`);
      let response;
      try {
        response = await call('GET', path);
      } catch (error) {
        return fail('GITHUB_UPSTREAM_ERROR', 'The asynchronous merge result could not be read from GitHub.', {
          phase: 'merge_result',
          may_have_mutated: false,
          github_message: String(error?.message || error),
        });
      }
      const status = Number(response?.status || 0);
      if (status === 200) return { ok: true, http_status: status, ...detailsFromAsync(response?.body) };
      if (status === 404) return fail('GITHUB_INTEGRATION_RESULT_EXPIRED', 'GitHub no longer retains this asynchronous merge result.', { upstream_status: 404 });
      return fail(status === 403 ? 'GITHUB_APP_PERMISSION_DENIED' : 'GITHUB_UPSTREAM_ERROR',
        upstreamMessage(response?.body, `GitHub returned HTTP ${status || 'unknown'}`), { upstream_status: status || null });
    },
  };
}

function publicReviewEvidence(review) {
  return {
    repo: review.repo || null,
    pull_request: review.pull_request || null,
    state: review.state,
    draft: review.draft,
    merged: review.merged,
    base: review.base,
    head: review.head,
    stack: review.stack,
    merge: review.merge,
    review: review.review,
    checks: review.checks,
    protection: review.protection,
    snapshot: review.snapshot,
  };
}

function waitingReasons(review) {
  const reasons = new Set();
  for (const reason of review.protection?.unsatisfied_requirements || []) {
    if (reason !== 'branch_up_to_date') reasons.add(String(reason));
  }
  if (review.checks?.required_satisfied !== true) reasons.add('required_status_checks');
  if (review.review?.changes_requested === true) reasons.add('changes_requested');
  if (review.protection?.thread_resolution_required === true
      && review.protection?.thread_resolution_satisfied !== true) reasons.add('conversation_resolution');
  if (review.review?.approval_requirement_satisfied === false) reasons.add('required_reviews');
  return [...reasons].sort();
}

function mergedOutcome(result, normalized) {
  const status = String(result?.status || '').toLowerCase();
  if (status === 'merged') {
    return {
      ok: true,
      outcome: 'merged',
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
      merge_request_uuid: result.uuid || normalized.merge_request_uuid || null,
      merge_commit_sha: result.sha || null,
      message: result.message || null,
    };
  }
  if (status === 'pending' || status === 'queued') {
    return {
      ok: true,
      outcome: 'merge_pending',
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
      merge_request_uuid: result.uuid || normalized.merge_request_uuid || null,
      message: result.message || null,
    };
  }
  if (status === 'failed' || status === 'cancelled') {
    return fail('GITHUB_INTEGRATION_MERGE_FAILED', result.message || 'GitHub did not merge the candidate.', {
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
      merge_request_uuid: result.uuid || normalized.merge_request_uuid || null,
      merge_status: status,
    });
  }
  return {
    ok: true,
    outcome: 'merge_pending',
    repo: normalized.repo,
    pull_request: normalized.pull_request,
    expected_head: normalized.expected_head,
    merge_request_uuid: result.uuid || normalized.merge_request_uuid || null,
    merge_status: status || null,
    message: result.message || null,
  };
}

export async function reconcileGithubIntegration(input, options = {}) {
  const normalized = normalize(input);
  if (!normalized.ok) return normalized;

  const integrationApi = options.integrationApi || (options.apiClient ? createGithubIntegrationApiAdapter(options.apiClient) : null);

  if (normalized.merge_request_uuid) {
    if (!integrationApi) return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub merge-result transport is required.');
    const result = await integrationApi.getMergeResult({
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      merge_request_uuid: normalized.merge_request_uuid,
    });
    if (!result.ok) return result;
    return mergedOutcome(result, normalized);
  }

  const reviewPullRequest = options.reviewPullRequest || reviewGithubPullRequestWithGitHubApp;
  const review = await reviewPullRequest({
    repo: normalized.repo,
    pull_request: normalized.pull_request,
    expected_head: normalized.expected_head,
  });
  if (!review?.ok) return review || fail('GITHUB_REVIEW_PACKET_FAILED', 'GitHub review packet failed.');

  if (review.merged) {
    return {
      ok: true,
      outcome: 'already_merged',
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
      evidence: publicReviewEvidence(review),
    };
  }
  if (review.state !== 'open') return fail('GITHUB_INTEGRATION_PULL_REQUEST_CLOSED', 'Only an open pull request can be integrated.', { evidence: publicReviewEvidence(review) });
  if (review.draft) return { ok: true, outcome: 'waiting', waiting_on: ['draft'], evidence: publicReviewEvidence(review) };
  if (review.cross_repository) {
    return fail('GITHUB_INTEGRATION_CROSS_REPOSITORY_UNSUPPORTED', 'Automatic integration is limited to same-repository pull requests so branch ownership remains deterministic.', {
      evidence: publicReviewEvidence(review),
    });
  }
  if (review.protection?.available !== true || review.protection?.configured !== true) {
    return fail('GITHUB_INTEGRATION_POLICY_NOT_CONFIGURED', 'The target branch must have the portfolio branch policy configured before automatic integration.', {
      evidence: publicReviewEvidence(review),
    });
  }
  if (review.protection?.rulesets_complete === false) {
    return fail('GITHUB_INTEGRATION_POLICY_EVIDENCE_INCOMPLETE', 'The target branch ruleset could not be observed completely; refusing automatic integration.', {
      evidence: publicReviewEvidence(review),
    });
  }

  const branchBehind = review.merge?.merge_state === 'behind'
    || (review.protection?.branch_up_to_date_required === true && review.protection?.branch_up_to_date_satisfied === false);
  if (branchBehind) {
    if (review.stack) {
      return {
        ok: true,
        outcome: 'stack_rebase_required',
        repo: normalized.repo,
        pull_request: normalized.pull_request,
        expected_head: normalized.expected_head,
        stack: review.stack,
        recovery: {
          mechanism: 'github_stack_cascading_rebase',
          local_commands: ['gh stack rebase', 'gh stack push'],
          reason: 'An ordinary update-branch merge would violate stacked PR linear-history requirements.',
        },
        evidence: publicReviewEvidence(review),
      };
    }
    if (!normalized.apply) {
      return {
        ok: true,
        outcome: 'needs_update',
        repo: normalized.repo,
        pull_request: normalized.pull_request,
        expected_head: normalized.expected_head,
        evidence: publicReviewEvidence(review),
      };
    }
    if (!integrationApi) return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub branch-update transport is required for this stale standalone pull request.');
    const update = await integrationApi.updateBranch({
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
    });
    if (!update.ok) return update;
    return {
      ok: true,
      outcome: 'updated_for_recheck',
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      previous_head: normalized.expected_head,
      message: update.message || null,
      next: 'Re-read the PR head and wait for exact-head verification before integration.',
    };
  }

  const waiting = waitingReasons(review);
  if (waiting.length) {
    return {
      ok: true,
      outcome: 'waiting',
      waiting_on: waiting,
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
      evidence: publicReviewEvidence(review),
    };
  }

  if (review.merge?.mergeable === false) {
    return fail('GITHUB_INTEGRATION_CONFLICT', 'GitHub reports that the pull request cannot be merged cleanly.', { evidence: publicReviewEvidence(review) });
  }
  if (review.merge?.mergeable !== true) {
    return {
      ok: true,
      outcome: 'waiting',
      waiting_on: ['mergeability'],
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
      evidence: publicReviewEvidence(review),
    };
  }

  if (!normalized.apply) {
    return {
      ok: true,
      outcome: 'ready',
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
      stack_atomic: Boolean(review.stack),
      integration_method: 'github_async_merge',
      merge_method: 'squash',
      merge_action: 'direct_merge',
      evidence: publicReviewEvidence(review),
    };
  }

  if (!integrationApi) return fail('GITHUB_TRANSPORT_UNAVAILABLE', 'A GitHub merge transport is required for this ready pull request.');
  const merge = await integrationApi.mergeAsync({
    repo: normalized.repo,
    pull_request: normalized.pull_request,
    expected_head: normalized.expected_head,
    merge_method: 'squash',
    merge_action: 'direct_merge',
  });
  if (!merge.ok) return merge;
  if (String(merge.status || '').toLowerCase() === 'merged') {
    return {
      ...mergedOutcome(merge, normalized),
      stack_atomic: Boolean(review.stack),
      evidence: publicReviewEvidence(review),
    };
  }
  return {
    ok: true,
    outcome: 'merge_submitted',
    repo: normalized.repo,
    pull_request: normalized.pull_request,
    expected_head: normalized.expected_head,
    merge_request_uuid: merge.uuid || null,
    stack_atomic: Boolean(review.stack),
    integration_method: 'github_async_merge',
    merge_method: 'squash',
    merge_action: 'direct_merge',
    existing_request: Boolean(merge.existing_request),
    evidence: publicReviewEvidence(review),
  };
}

function mapAuthError(error, requiredPermissions = {}) {
  const message = String(error?.message || 'GitHub App authentication failed.');
  if (/config\/get 412|declared as required but not set/i.test(message)) {
    return fail('GITHUB_APP_SETUP_REQUIRED', 'Configure the GitHub App ID and private key in Hatchable Setup before using automatic integration.');
  }
  if ([401, 403, 422].includes(Number(error?.status))) {
    return fail('GITHUB_APP_PERMISSION_DENIED', message, {
      upstream_status: Number(error.status),
      required_permissions: requiredPermissions,
    });
  }
  if (Number(error?.status) === 404) return fail('GITHUB_APP_INSTALLATION_NOT_FOUND', 'The GitHub App is not installed for this repository.', { upstream_status: 404 });
  return fail(error?.code || 'GITHUB_APP_AUTH_ERROR', message, error?.status ? { upstream_status: Number(error.status) } : null);
}

function branchUpdateCapabilityFallback(preflight, error) {
  const mapped = mapAuthError(error, { contents: 'write', pull_requests: 'write' });
  if (mapped.error !== 'GITHUB_APP_PERMISSION_DENIED') return mapped;
  return {
    ...preflight,
    branch_update_capability: 'unavailable',
    recovery: {
      mechanism: 'isolated_worktree_update',
      local_commands: [
        'git fetch origin',
        `git merge --no-edit origin/${preflight?.evidence?.base?.ref || 'main'}`,
        'git push',
      ],
      reason: 'The installed GitHub App can merge with Contents: write but does not currently grant Pull requests: write for GitHub update-branch. Update the standalone branch in its isolated worktree, then reread the head and verification.',
    },
    capability_error: mapped.error,
  };
}

export async function reconcileGithubIntegrationWithGitHubApp(input, options = {}) {
  const normalized = normalize(input);
  if (!normalized.ok) return normalized;

  if (normalized.merge_request_uuid) {
    try {
      return await withGitHubAppApiClient(normalized.repo, async (apiClient) => {
        return reconcileGithubIntegration(normalized, { ...options, apiClient });
      }, { permissionProfile: 'integration_merge' });
    } catch (error) {
      return mapAuthError(error, { contents: 'write' });
    }
  }

  let review;
  try {
    review = await reviewGithubPullRequestWithGitHubApp({
      repo: normalized.repo,
      pull_request: normalized.pull_request,
      expected_head: normalized.expected_head,
    });
  } catch (error) {
    return mapAuthError(error);
  }
  if (!review.ok) return review;

  const preflight = await reconcileGithubIntegration(
    { ...normalized, apply: false },
    { ...options, reviewPullRequest: async () => review },
  );
  if (!normalized.apply || !preflight.ok) return preflight;
  if (!['ready', 'needs_update'].includes(preflight.outcome)) return preflight;

  if (preflight.outcome === 'needs_update') {
    try {
      return await withGitHubAppApiClient(normalized.repo, async (apiClient) => {
        return reconcileGithubIntegration(normalized, {
          ...options,
          apiClient,
          reviewPullRequest: async () => review,
        });
      }, { permissionProfile: 'integration_update' });
    } catch (error) {
      return branchUpdateCapabilityFallback(preflight, error);
    }
  }

  try {
    return await withGitHubAppApiClient(normalized.repo, async (apiClient) => {
      return reconcileGithubIntegration(normalized, {
        ...options,
        apiClient,
        reviewPullRequest: async () => review,
      });
    }, { permissionProfile: 'integration_merge' });
  } catch (error) {
    return mapAuthError(error, { contents: 'write' });
  }
}