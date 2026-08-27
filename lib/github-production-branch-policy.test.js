import { reconcileGithubProductionBranchPolicy } from 'lib/github-production-branch-policy.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
const HEAD = 'a'.repeat(40);

function roles() { return { development_branch: 'dev', production_branch: 'main' }; }

function github(existing = null) {
  const state = { head: HEAD, ruleset: existing, creates: 0, updates: 0 };
  return {
    state,
    async getBranch() { return { branch: 'main', sha: state.head }; },
    async listRulesets() { return state.ruleset ? [{ id: 9, name: state.ruleset.name }] : []; },
    async getRuleset() { return state.ruleset ? { id: 9, ...state.ruleset } : null; },
    async createRuleset(_repo, body) { state.creates += 1; state.ruleset = body; return { id: 9, ...body }; },
    async updateRuleset(_repo, _id, body) { state.updates += 1; state.ruleset = body; return { id: 9, ...body }; },
  };
}

export async function runGithubProductionBranchPolicyTests() {
  const results = [];
  async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); } }

  await test('production rules protect explicit main without requiring PR merges', async () => {
    const api = github();
    const result = await reconcileGithubProductionBranchPolicy({ repo: 'laurajoyhutchins/overcenter', expected_head: HEAD }, { github: api, branchRoles: roles() });
    assert(result.ok === true && result.changed === true, 'policy was not created');
    const types = api.state.ruleset.rules.map(rule => rule.type).sort();
    assert(JSON.stringify(types) === JSON.stringify(['deletion','non_fast_forward','required_linear_history'].sort()), `unexpected ${types}`);
    assert(!types.includes('pull_request'), 'production policy incorrectly requires PR merge');
    assert(api.state.ruleset.conditions.ref_name.include[0] === 'refs/heads/main', 'production branch not explicit');
  });

  await test('identical production policy is idempotent', async () => {
    const firstApi = github();
    await reconcileGithubProductionBranchPolicy({ repo: 'laurajoyhutchins/overcenter', expected_head: HEAD }, { github: firstApi, branchRoles: roles() });
    const api = github(firstApi.state.ruleset);
    const result = await reconcileGithubProductionBranchPolicy({ repo: 'laurajoyhutchins/overcenter', expected_head: HEAD }, { github: api, branchRoles: roles() });
    assert(result.ok === true && result.changed === false, 'identical policy mutated');
    assert(api.state.updates === 0 && api.state.creates === 0, 'idempotent reconcile wrote GitHub');
  });

  await test('stale production head rejects before policy mutation', async () => {
    const api = github(); api.state.head = 'b'.repeat(40);
    const result = await reconcileGithubProductionBranchPolicy({ repo: 'laurajoyhutchins/overcenter', expected_head: HEAD }, { github: api, branchRoles: roles() });
    assert(result.error === 'HEAD_MISMATCH', `unexpected ${result.error}`);
    assert(api.state.creates === 0 && api.state.updates === 0, 'stale head mutated rules');
  });

  await test('branch roles are mandatory', async () => {
    const api = github();
    const result = await reconcileGithubProductionBranchPolicy({ repo: 'laurajoyhutchins/overcenter', expected_head: HEAD }, { github: api, branchRoles: null });
    assert(result.error === 'GITHUB_PRODUCTION_BRANCH_POLICY_ROLES_REQUIRED', `unexpected ${result.error}`);
  });

  return { ok: results.every(result => result.ok), passed: results.filter(result => result.ok).length, total: results.length, results };
}
