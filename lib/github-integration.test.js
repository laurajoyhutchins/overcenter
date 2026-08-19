import { createGithubIntegrationApiAdapter, reconcileGithubIntegration } from 'lib/github-integration.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const BASE = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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
    check(api.calls.length === 1 && api.calls[0].op === 'update', 'expected one update-branch mutation');
    check(api.calls[0].expected_head === HEAD, 'update-branch omitted exact head fence');
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

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, results };
}