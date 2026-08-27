import {
  applyGithubChangesetRoleAware,
  createGithubPullRequestRoleAware,
  reconcileGithubIntegrationRoleAware,
} from 'lib/github-branch-role-runtime.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function configuredRoles() {
  return {
    async get() {
      return { ok: true, repository: 'laurajoyhutchins/overcenter', development_branch: 'dev', production_branch: 'main', production_source_ref: 'hatchable:test', changed: false };
    },
  };
}

function unconfiguredRoles() {
  return { async get() { return null; } };
}

export async function runGithubBranchRoleRuntimeTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('configured PR creation rejects production base before delegate', async () => {
    let delegated = 0;
    const result = await createGithubPullRequestRoleAware(
      { repo: 'laurajoyhutchins/overcenter', base: 'main' },
      { branchRoleService: configuredRoles(), createPullRequest: async () => { delegated += 1; return { ok: true }; } },
    );
    assert(result.error === 'GITHUB_BRANCH_ROLE_VIOLATION', `unexpected ${result.error}`);
    assert(result.expected_base === 'dev', 'expected dev base missing');
    assert(delegated === 0, 'delegate ran before branch-role rejection');
  });

  await test('unconfigured PR creation preserves existing delegate behavior', async () => {
    let delegated = 0;
    const result = await createGithubPullRequestRoleAware(
      { repo: 'laurajoyhutchins/example', base: 'main' },
      { branchRoleService: unconfiguredRoles(), createPullRequest: async () => { delegated += 1; return { ok: true, outcome: 'delegated' }; } },
    );
    assert(result.ok === true && result.outcome === 'delegated', 'existing behavior was not delegated');
    assert(delegated === 1, 'delegate did not run exactly once');
  });

  await test('configured changeset rejects dev and production but delegates work branch', async () => {
    for (const branch of ['dev', 'main']) {
      let delegated = 0;
      const result = await applyGithubChangesetRoleAware(
        { repo: 'laurajoyhutchins/overcenter', branch },
        { branchRoleService: configuredRoles(), applyChangeset: async () => { delegated += 1; return { ok: true }; } },
      );
      assert(result.error === 'GITHUB_BRANCH_ROLE_VIOLATION', `${branch} was accepted`);
      assert(delegated === 0, `${branch} reached delegate`);
    }
    const allowed = await applyGithubChangesetRoleAware(
      { repo: 'laurajoyhutchins/overcenter', branch: 'feat/example' },
      { branchRoleService: configuredRoles(), applyChangeset: async () => ({ ok: true, outcome: 'delegated' }) },
    );
    assert(allowed.outcome === 'delegated', 'work branch was not delegated');
  });

  await test('integration rereads PR base and rejects production before delegate', async () => {
    let delegated = 0;
    const result = await reconcileGithubIntegrationRoleAware(
      { repo: 'laurajoyhutchins/overcenter', pull_request: 178 },
      {
        branchRoleService: configuredRoles(),
        readPullRequestBase: async () => 'main',
        reconcileIntegration: async () => { delegated += 1; return { ok: true }; },
      },
    );
    assert(result.error === 'GITHUB_BRANCH_ROLE_VIOLATION', `unexpected ${result.error}`);
    assert(delegated === 0, 'integration delegated after production-base observation');
  });

  await test('malformed requests retain original command validation path', async () => {
    let delegated = 0;
    const expected = { ok: false, error: 'INVALID_REPOSITORY' };
    const result = await createGithubPullRequestRoleAware(
      { repo: 'not a repo', base: 'main' },
      { branchRoleService: configuredRoles(), createPullRequest: async () => { delegated += 1; return expected; } },
    );
    assert(delegated === 1, 'malformed request was intercepted by branch-role lookup');
    assert(result.error === 'INVALID_REPOSITORY', `unexpected ${result.error}`);
  });

  return { ok: results.every((result) => result.ok), passed: results.filter((result) => result.ok).length, total: results.length, results };
}
