import { createGithubIntegrationApiAdapter, reconcileGithubIntegration, reconcileGithubIntegrationWithGitHubApp } from 'lib/github-integration.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const UPDATED_HEAD = 'dddddddddddddddddddddddddddddddddddddddd';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function packet(overrides = {}) {
  const base = {
    ok: true,
    state: 'open',
    draft: false,
    merged: false,
    base: { ref: 'main', sha: BASE },
    head: { ref: 'feat/example', sha: HEAD, repo: 'owner/repo' },
    cross_repository: false,
    stack: null,
    merge: { mergeable: true, merge_state: 'clean' },
    review: {
      changes_requested: false,
      threads_complete: true,
      unresolved_thread_count: 0,
      approval_requirement_satisfied: true,
    },
    checks: {
      required_set_complete: true,
      required_satisfied: true,
      pending_required: [],
      failing_required: [],
      missing_required: [],
      unobserved_required: [],
    },
    protection: {
      available: true,
      configured: true,
      evaluation: 'satisfied',
      unsatisfied_requirements: [],
      branch_up_to_date_required: true,
      branch_up_to_date_satisfied: true,
      thread_resolution_required: true,
      thread_resolution_satisfied: true,
      rulesets_complete: true,
    },
    snapshot: { head_sha: HEAD, base_sha: BASE, sha256: 'snapshot' },
  };
  return {
    ...base,
    ...overrides,
    base: { ...base.base, ...(overrides.base || {}) },
    head: { ...base.head, ...(overrides.head || {}) },
    merge: { ...base.merge, ...(overrides.merge || {}) },
    review: { ...base.review, ...(overrides.review || {}) },
    checks: { ...base.checks, ...(overrides.checks || {}) },
    protection: { ...base.protection, ...(overrides.protection || {}) },
  };
}

function fakeApi() {
  const calls = [];
  return {
    calls,
    async updateBranch(input) {
      calls.push({ op: 'update', ...input });
      return { ok: true, status: 202, message: 'Updating pull request branch.' };
    },
    async readPullRequestCoordinate(input) {
      calls.push({ op: 'read_coordinate', ...input });
      return { ok: true, head: { sha: UPDATED_HEAD }, base: { ref: 'main', sha: BASE } };
    },
    async mergeAsync(input) {
      calls.push({ op: 'merge', ...input });
      return { ok: true, status: 'pending', uuid: 'merge-uuid' };
    },
    async getMergeResult(input) {
      calls.push({ op: 'poll', ...input });
      return { ok: true, status: 'merged', sha: 'cccccccccccccccccccccccccccccccccccccccc' };
    },
  };
}

export async function runGithubIntegrationTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('inspect reports a protected exact-head PR ready without any write transport', async () => {
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: false,
    }, { reviewPullRequest: async () => packet() });
    check(result.ok && result.outcome === 'ready', `unexpected outcome ${JSON.stringify(result)}`);
  });

  await test('apply updates a stale standalone branch using exact expected head', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet({
        merge: { merge_state: 'behind' },
        protection: { evaluation: 'unsatisfied', unsatisfied_requirements: ['branch_up_to_date'], branch_up_to_date_satisfied: false },
      }),
      integrationApi: api,
    });
    check(result.ok && result.outcome === 'updated_for_recheck', `unexpected outcome ${JSON.stringify(result)}`);
    check(api.calls.length === 2 && api.calls[0].op === 'update' && api.calls[1].op === 'read_coordinate', 'expected update followed by authoritative coordinate reread');
    check(api.calls[0].expected_head === HEAD, 'update-branch omitted exact head fence');
    check(result.head?.sha === UPDATED_HEAD && result.base?.sha === BASE, 'updated result omitted refreshed head/base coordinate');
  });

  await test('stale standalone PR can be identified before integration policy is configured', async () => {
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: false,
    }, {
      reviewPullRequest: async () => packet({
        merge: { merge_state: 'behind' },
        protection: { available: false, configured: false, evaluation: 'not_configured', branch_up_to_date_satisfied: false },
      }),
    });
    check(result.ok && result.outcome === 'needs_update', `unexpected outcome ${JSON.stringify(result)}`);
  });

  await test('authoritative current-base freshness permits only update before integration policy gating', async () => {
    const calls = [];
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet({
        protection: { available: false, configured: false, evaluation: 'not_configured' },
      }),
      integrationApi: {
        async inspectBranchFreshness(input) {
          calls.push({ op: 'freshness', ...input });
          return { ok: true, behind: true, behind_by: 9, head: { sha: HEAD }, base: { ref: 'main', sha: BASE } };
        },
        async updateBranch(input) {
          calls.push({ op: 'update', ...input });
          return { ok: true, status: 202, message: 'Updating pull request branch.' };
        },
        async readPullRequestCoordinate(input) {
          calls.push({ op: 'read_coordinate', ...input });
          return { ok: true, head: { sha: UPDATED_HEAD }, base: { ref: 'main', sha: BASE } };
        },
        async mergeAsync(input) {
          calls.push({ op: 'merge', ...input });
          return { ok: true, status: 'pending', uuid: 'must-not-merge' };
        },
      },
    });
    check(result.ok && result.outcome === 'updated_for_recheck', `unexpected outcome ${JSON.stringify(result)}`);
    check(JSON.stringify(calls.map(call => call.op)) === JSON.stringify(['freshness', 'update', 'read_coordinate']), `unexpected operations ${JSON.stringify(calls)}`);
  });

  await test('up-to-date PR still fails closed when integration policy is unavailable', async () => {
    const calls = [];
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet({ protection: { available: false, configured: false, evaluation: 'not_configured' } }),
      integrationApi: {
        async inspectBranchFreshness(input) {
          calls.push({ op: 'freshness', ...input });
          return { ok: true, behind: false, behind_by: 0, head: { sha: HEAD }, base: { ref: 'main', sha: BASE } };
        },
      },
    });
    check(!result.ok && result.error === 'GITHUB_INTEGRATION_POLICY_NOT_CONFIGURED', `unexpected result ${JSON.stringify(result)}`);
    check(JSON.stringify(calls.map(call => call.op)) === JSON.stringify(['freshness']), 'up-to-date unprotected PR performed a mutation');
  });

  await test('stale stack remains non-mutating before integration policy gating', async () => {
    const calls = [];
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 9, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet({
        stack: { number: 4, size: 3, position: 3, base: { ref: 'main' } },
        protection: { available: false, configured: false, evaluation: 'not_configured' },
      }),
      integrationApi: {
        async inspectBranchFreshness(input) {
          calls.push({ op: 'freshness', ...input });
          return { ok: true, behind: true, behind_by: 3, head: { sha: HEAD }, base: { ref: 'main', sha: BASE } };
        },
      },
    });
    check(result.ok && result.outcome === 'stack_rebase_required', `unexpected result ${JSON.stringify(result)}`);
    check(JSON.stringify(calls.map(call => call.op)) === JSON.stringify(['freshness']), 'stale stack was mutated before policy gating');
  });

  await test('stale stack is never merge-updated and requires cascading rebase', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 9, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet({
        stack: { number: 4, size: 3, position: 3, base: { ref: 'main' } },
        merge: { merge_state: 'behind' },
        protection: { evaluation: 'unsatisfied', unsatisfied_requirements: ['branch_up_to_date'], branch_up_to_date_satisfied: false },
      }),
      integrationApi: api,
    });
    check(result.ok && result.outcome === 'stack_rebase_required', `unexpected outcome ${JSON.stringify(result)}`);
    check(api.calls.length === 0, 'stale stack was mutated with ordinary update-branch');
  });

  await test('unprotected repositories are refused before mutation', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, { reviewPullRequest: async () => packet({ protection: { configured: false, evaluation: 'not_configured' } }), integrationApi: api });
    check(!result.ok && result.error === 'GITHUB_INTEGRATION_POLICY_NOT_CONFIGURED', `unexpected result ${JSON.stringify(result)}`);
    check(api.calls.length === 0, 'unprotected PR was mutated');
  });

  await test('plan-limited private repository can integrate a standalone PR under explicit exact-head fallback', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet({
        checks: {
          enumeration_complete: true,
          required_set_complete: false,
          required_satisfied: null,
          required_contexts: [],
        },
        protection: {
          available: false,
          configured: null,
          evaluation: 'unavailable',
          rulesets_available: false,
          rulesets_complete: false,
          rulesets_unavailable: {
            reason: 'permission_denied',
            error: 'GITHUB_PERMISSION_DENIED',
            upstream_status: 403,
          },
        },
      }),
      integrationApi: api,
    });
    check(result.ok && result.outcome === 'merge_submitted', `unexpected outcome ${JSON.stringify(result)}`);
    check(result.integration_policy === 'exact_head_plan_fallback', `fallback policy was not declared ${JSON.stringify(result)}`);
    check(api.calls.length === 1 && api.calls[0].op === 'merge', 'fallback did not issue exactly one exact-head merge');
    check(api.calls[0].expected_head === HEAD, 'fallback merge omitted exact head fence');
  });

  await test('plan-limited exact-head integration falls back to synchronous merge when async transport is forbidden', async () => {
    const calls = [];
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet({
        checks: {
          enumeration_complete: true,
          required_set_complete: false,
          required_satisfied: null,
          required_contexts: [],
        },
        protection: {
          available: false,
          configured: null,
          evaluation: 'unavailable',
          rulesets_available: false,
          rulesets_complete: false,
          rulesets_unavailable: {
            reason: 'permission_denied',
            error: 'GITHUB_PERMISSION_DENIED',
            upstream_status: 403,
          },
        },
      }),
      integrationApi: {
        async mergeAsync(input) {
          calls.push({ op: 'merge_async', ...input });
          return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', upstream_status: 403, message: 'Resource not accessible by integration' };
        },
        async mergeDirect(input) {
          calls.push({ op: 'merge_direct', ...input });
          return { ok: true, status: 'merged', sha: 'cccccccccccccccccccccccccccccccccccccccc', message: 'Pull Request successfully merged' };
        },
      },
    });
    check(result.ok && result.outcome === 'merged', `unexpected outcome ${JSON.stringify(result)}`);
    check(result.integration_policy === 'exact_head_plan_fallback', `fallback policy was not retained ${JSON.stringify(result)}`);
    check(result.integration_transport === 'direct_exact_head', `direct fallback transport was not declared ${JSON.stringify(result)}`);
    check(JSON.stringify(calls.map(call => call.op)) === JSON.stringify(['merge_async','merge_direct']), `unexpected merge calls ${JSON.stringify(calls)}`);
    check(calls[1].expected_head === HEAD && calls[1].merge_method === 'squash', 'direct fallback lost exact-head squash semantics');
  });

  await test('ordinary protected integration does not reinterpret async permission denial as a transport fallback', async () => {
    const calls = [];
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet(),
      integrationApi: {
        async mergeAsync(input) {
          calls.push({ op: 'merge_async', ...input });
          return { ok: false, error: 'GITHUB_APP_PERMISSION_DENIED', upstream_status: 403, message: 'Resource not accessible by integration' };
        },
        async mergeDirect(input) {
          calls.push({ op: 'merge_direct', ...input });
          return { ok: true, status: 'merged', sha: 'cccccccccccccccccccccccccccccccccccccccc' };
        },
      },
    });
    check(!result.ok && result.error === 'GITHUB_APP_PERMISSION_DENIED', `unexpected result ${JSON.stringify(result)}`);
    check(JSON.stringify(calls.map(call => call.op)) === JSON.stringify(['merge_async']), `ordinary integration used unsafe fallback ${JSON.stringify(calls)}`);
  });

  await test('pending required checks wait without mutation', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet({
        checks: { required_satisfied: false, pending_required: ['verify'] },
        protection: { evaluation: 'unsatisfied', unsatisfied_requirements: ['required_status_checks'] },
      }),
      integrationApi: api,
    });
    check(result.ok && result.outcome === 'waiting', `unexpected outcome ${JSON.stringify(result)}`);
    check(api.calls.length === 0, 'waiting PR was mutated');
  });

  await test('ready standalone PR submits exact-head asynchronous squash merge', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, { reviewPullRequest: async () => packet(), integrationApi: api });
    check(result.ok && result.outcome === 'merge_submitted', `unexpected outcome ${JSON.stringify(result)}`);
    check(api.calls.length === 1 && api.calls[0].op === 'merge', 'expected one async merge mutation');
    check(api.calls[0].expected_head === HEAD, 'async merge omitted exact head fence');
    check(api.calls[0].merge_method === 'squash' && api.calls[0].merge_action === 'direct_merge', 'async merge policy drifted');
  });

  await test('ready stacked PR uses the same atomic asynchronous merge primitive', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 9, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequest: async () => packet({ stack: { number: 4, size: 3, position: 3, base: { ref: 'main' } } }),
      integrationApi: api,
    });
    check(result.ok && result.outcome === 'merge_submitted' && result.stack_atomic === true, `unexpected outcome ${JSON.stringify(result)}`);
    check(api.calls.length === 1 && api.calls[0].op === 'merge', 'stack did not use async merge');
  });

  await test('polling an asynchronous merge result is read-only and attributable', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: false, merge_request_uuid: 'merge-uuid',
    }, { reviewPullRequest: async () => packet(), integrationApi: api });
    check(result.ok && result.outcome === 'merged', `unexpected outcome ${JSON.stringify(result)}`);
    check(api.calls.length === 1 && api.calls[0].op === 'poll', 'expected one merge-result read');
  });

  await test('cross-repository PRs are not automatically integrated', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, { reviewPullRequest: async () => packet({ cross_repository: true, head: { repo: 'someone/fork' } }), integrationApi: api });
    check(!result.ok && result.error === 'GITHUB_INTEGRATION_CROSS_REPOSITORY_UNSUPPORTED', `unexpected result ${JSON.stringify(result)}`);
    check(api.calls.length === 0, 'cross-repository PR was mutated');
  });

  await test('already merged PRs are idempotent', async () => {
    const api = fakeApi();
    const result = await reconcileGithubIntegration({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, { reviewPullRequest: async () => packet({ state: 'closed', merged: true }), integrationApi: api });
    check(result.ok && result.outcome === 'already_merged', `unexpected outcome ${JSON.stringify(result)}`);
    check(api.calls.length === 0, 'already merged PR was mutated');
  });

  await test('lost merge transport certainty is explicit and requires reconciliation', async () => {
    const api = createGithubIntegrationApiAdapter({
      async call() { throw new Error('socket disappeared after write'); },
    });
    const result = await api.mergeAsync({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD,
      merge_method: 'squash', merge_action: 'direct_merge',
    });
    check(!result.ok && result.error === 'GITHUB_INTEGRATION_INDETERMINATE', `unexpected result ${JSON.stringify(result)}`);
    check(result.may_have_mutated === true && result.phase === 'merge_async', 'indeterminate merge lost mutation evidence');
  });

  await test('lost update-branch transport certainty is explicit and requires reconciliation', async () => {
    const api = createGithubIntegrationApiAdapter({
      async call() { throw new Error('socket disappeared after write'); },
    });
    const result = await api.updateBranch({ repo: 'owner/repo', pull_request: 7, expected_head: HEAD });
    check(!result.ok && result.error === 'GITHUB_INTEGRATION_INDETERMINATE', `unexpected result ${JSON.stringify(result)}`);
    check(result.may_have_mutated === true && result.phase === 'update_branch', 'indeterminate update lost mutation evidence');
  });

  await test('GitHub App wrapper read-only inspection never requests a write token', async () => {
    let withAppCalls = 0;
    const result = await reconcileGithubIntegrationWithGitHubApp({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: false,
    }, {
      reviewPullRequestWithGitHubApp: async () => packet(),
      withGitHubAppApiClient: async () => { withAppCalls += 1; throw new Error('write token should not be requested'); },
    });
    check(result.ok && result.outcome === 'ready', `unexpected result ${JSON.stringify(result)}`);
    check(withAppCalls === 0, 'read-only wrapper requested a write token');
  });

  await test('GitHub App wrapper requests contents-write only for exact-head async merge', async () => {
    const profiles = [];
    const result = await reconcileGithubIntegrationWithGitHubApp({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequestWithGitHubApp: async () => packet(),
      withGitHubAppApiClient: async (_repo, callback, options) => {
        profiles.push(options?.permissionProfile || null);
        return callback({
          async call(_name, request = {}) {
            const method = String(request.method || 'GET').toUpperCase();
            const path = String(request.path || '');
            if (method === 'GET' && path === '/repos/owner/repo/pulls/7') return { status: 200, body: { head: { sha: HEAD }, base: { ref: 'main' } } };
            if (method === 'GET' && path === '/repos/owner/repo/branches/main') return { status: 200, body: { commit: { sha: BASE } } };
            if (method === 'GET' && path === '/repos/owner/repo/compare/' + BASE + '...' + HEAD) return { status: 200, body: { behind_by: 0, status: 'ahead' } };
            if (method === 'PUT' && path === '/repos/owner/repo/pulls/7/merge-async') return { status: 202, body: { status: 'pending', details: { uuid: 'merge-uuid' } } };
            throw new Error('unexpected GitHub call ' + method + ' ' + path);
          },
        });
      },
    });
    check(result.ok && result.outcome === 'merge_submitted', `unexpected result ${JSON.stringify(result)}`);
    check(JSON.stringify(profiles) === JSON.stringify(['integration_merge']), `unexpected permission profiles ${JSON.stringify(profiles)}`);
  });

  await test('missing optional pull-request write permission degrades stale standalone update to worktree recovery', async () => {
    const profiles = [];
    const denied = new Error('permission not granted');
    denied.status = 422;
    const result = await reconcileGithubIntegrationWithGitHubApp({
      repo: 'owner/repo', pull_request: 7, expected_head: HEAD, apply: true,
    }, {
      reviewPullRequestWithGitHubApp: async () => packet({
        merge: { merge_state: 'behind' },
        protection: { evaluation: 'unsatisfied', unsatisfied_requirements: ['branch_up_to_date'], branch_up_to_date_satisfied: false },
      }),
      withGitHubAppApiClient: async (_repo, _callback, options) => {
        profiles.push(options?.permissionProfile || null);
        throw denied;
      },
    });
    check(result.ok && result.outcome === 'needs_update', `unexpected result ${JSON.stringify(result)}`);
    check(result.branch_update_capability === 'unavailable', 'permission fallback was not explicit');
    check(result.recovery?.mechanism === 'isolated_worktree_update', 'worktree recovery instructions missing');
    check(JSON.stringify(profiles) === JSON.stringify(['integration_update']), `unexpected permission profiles ${JSON.stringify(profiles)}`);
  });

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}