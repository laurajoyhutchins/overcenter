import {
  markGithubPullRequestReady,
  markGithubPullRequestReadyWithGitHubApp,
  normalizeGithubPullRequestReadyRequest,
} from 'lib/github-pull-request-ready.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function pr(overrides = {}) {
  return {
    id: 'PR_kwDO_fixture',
    number: 54,
    state: 'OPEN',
    isDraft: true,
    merged: false,
    headRefOid: HEAD,
    viewerCanUpdate: true,
    viewerDidAuthor: false,
    url: 'https://github.com/owner/repo/pull/54',
    ...overrides,
  };
}

function queryResponse(pullRequest) {
  return { status: 200, headers: {}, body: { data: { repository: { id: 'R_fixture', pullRequest } } } };
}

function mutationResponse(pullRequest) {
  return { status: 200, headers: {}, body: { data: { markPullRequestReadyForReview: { clientMutationId: 'fixture', pullRequest } } } };
}

function fakeApi(steps) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async graphql(query, variables) {
      calls.push({ query, variables });
      const step = steps[index++];
      if (!step) throw new Error(`unexpected GraphQL call ${index}`);
      if (step.throw) throw step.throw;
      return step.response;
    },
  };
}

export async function runGithubPullRequestReadyTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('request validation is strict and exact-head scoped', async () => {
    const good = normalizeGithubPullRequestReadyRequest({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD });
    check(good.ok && good.expected_head === HEAD, 'valid request was rejected');
    const bad = normalizeGithubPullRequestReadyRequest({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD, surprise: true });
    check(!bad.ok && bad.error === 'INVALID_REQUEST', 'unknown request field was accepted');
  });

  await test('already-ready pull requests are idempotent and do not mutate', async () => {
    const api = fakeApi([{ response: queryResponse(pr({ isDraft: false })) }]);
    const result = await markGithubPullRequestReady({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD }, { apiClient: api });
    check(result.ok && result.outcome === 'already_ready' && result.mutation_attempted === false, `unexpected result ${JSON.stringify(result)}`);
    check(api.calls.length === 1, 'already-ready pull request triggered a mutation');
  });

  await test('exact-head draft is marked ready and authoritatively re-read', async () => {
    const api = fakeApi([
      { response: queryResponse(pr()) },
      { response: mutationResponse(pr({ isDraft: false })) },
      { response: queryResponse(pr({ isDraft: false })) },
    ]);
    const result = await markGithubPullRequestReady({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD }, { apiClient: api });
    check(result.ok && result.outcome === 'marked_ready' && result.draft === false, `unexpected result ${JSON.stringify(result)}`);
    check(api.calls.length === 3 && /mutation GitHubMarkPullRequestReady/.test(api.calls[1].query), 'expected exactly one mark-ready mutation between authoritative reads');
  });

  await test('stale expected head is refused before mutation', async () => {
    const api = fakeApi([{ response: queryResponse(pr({ headRefOid: OTHER })) }]);
    const result = await markGithubPullRequestReady({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD }, { apiClient: api });
    check(!result.ok && result.error === 'HEAD_MISMATCH', `unexpected result ${JSON.stringify(result)}`);
    check(api.calls.length === 1, 'head mismatch triggered a mutation');
  });

  await test('closed non-merged pull request is refused before mutation', async () => {
    const api = fakeApi([{ response: queryResponse(pr({ state: 'CLOSED' })) }]);
    const result = await markGithubPullRequestReady({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD }, { apiClient: api });
    check(!result.ok && result.error === 'GITHUB_PULL_REQUEST_CLOSED', `unexpected result ${JSON.stringify(result)}`);
    check(api.calls.length === 1, 'closed pull request triggered a mutation');
  });

  await test('actor unauthorized is refused before mutation', async () => {
    const api = fakeApi([{ response: queryResponse(pr({ viewerCanUpdate: false, viewerDidAuthor: false })) }]);
    const result = await markGithubPullRequestReady({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD }, { apiClient: api });
    check(!result.ok && result.error === 'GITHUB_PULL_REQUEST_READY_ACTOR_UNAUTHORIZED', `unexpected result ${JSON.stringify(result)}`);
    check(api.calls.length === 1, 'actor-unauthorized pull request triggered a mutation');
  });

  await test('permission denial is explicit and non-ambiguous', async () => {
    const api = fakeApi([
      { response: queryResponse(pr({ viewerCanUpdate: true, viewerDidAuthor: false })) },
      { response: { status: 200, headers: {}, body: { data: { markPullRequestReadyForReview: null }, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] } } },
    ]);
    const result = await markGithubPullRequestReady({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD }, { apiClient: api });
    check(!result.ok && result.error === 'GITHUB_PERMISSION_DENIED' && result.may_have_mutated === false, `unexpected result ${JSON.stringify(result)}`);
    check(result.authorization?.viewer_can_update === true && result.authorization?.viewer_did_author === false, 'permission denial omitted installation-actor authorization evidence');
  });

  await test('lost mutation acknowledgement reconciles to success when GitHub proves ready', async () => {
    const api = fakeApi([
      { response: queryResponse(pr()) },
      { throw: new Error('socket disappeared after write') },
      { response: queryResponse(pr({ isDraft: false })) },
    ]);
    const result = await markGithubPullRequestReady({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD }, { apiClient: api });
    check(result.ok && result.outcome === 'marked_ready' && result.reconciled_after_indeterminate === true, `unexpected result ${JSON.stringify(result)}`);
  });

  await test('lost mutation acknowledgement stays indeterminate when GitHub does not prove convergence', async () => {
    const api = fakeApi([
      { response: queryResponse(pr()) },
      { throw: new Error('socket disappeared after write') },
      { response: queryResponse(pr()) },
    ]);
    const result = await markGithubPullRequestReady({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD }, { apiClient: api });
    check(!result.ok && result.error === 'GITHUB_PULL_REQUEST_READY_INDETERMINATE' && result.may_have_mutated === true, `unexpected result ${JSON.stringify(result)}`);
  });

  await test('GitHub App wrapper requests only the command-owned mark-ready profile', async () => {
    let profile = null;
    const api = fakeApi([{ response: queryResponse(pr({ isDraft: false })) }]);
    const result = await markGithubPullRequestReadyWithGitHubApp({ repo: 'owner/repo', pull_request: 54, expected_head: HEAD }, {
      withGitHubAppApiClient: async (_repo, callback, options) => {
        profile = options.permissionProfile;
        return callback(api);
      },
    });
    check(result.ok && profile === 'pull_request_mark_ready', `wrong permission profile ${profile}`);
  });

  return { ok: results.every((item) => item.ok), passed: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length, results };
}