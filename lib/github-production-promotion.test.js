import { promoteGithubProduction } from 'lib/github-production-promotion.js';

function assert(condition, message) { if (!condition) throw new Error(message); }
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

function request(overrides = {}) {
  return {
    repo: 'laurajoyhutchins/overcenter',
    candidate_sha: B,
    observed_development_head: B,
    observed_production_head: A,
    verification_run_id: 12345,
    idempotency_key: 'promotion:test:1',
    ...overrides,
  };
}

function roles() { return { development_branch: 'dev', production_branch: 'main' }; }

function github(overrides = {}) {
  const state = { dev: B, main: A, updates: [] };
  return {
    state,
    async getBranch(_repo, branch) { return { branch, sha: state[branch] }; },
    async compare() { return { status: 'ahead' }; },
    async getWorkflowRun() {
      return { id: 12345, path: '.github/workflows/exact-revision-v8.yml', event: 'push', head_branch: 'dev', head_sha: B, status: 'completed', conclusion: 'success', html_url: 'https://github.com/example/run/12345' };
    },
    async updateBranch(_repo, branch, sha) { state.updates.push({ branch, sha }); state[branch] = sha; return { ok: true }; },
    ...overrides,
  };
}

function memoryReceipts() {
  const rows = new Map();
  return {
    async claim(normalized, digest) {
      const key = `${normalized.repo}:${normalized.idempotency_key}`;
      const row = rows.get(key);
      if (row) {
        if (row.request_sha256 !== digest) return { kind: 'conflict', row };
        if (row.state === 'succeeded') return { kind: 'existing', row };
        return { kind: 'in_progress', row };
      }
      const claimed = { ...normalized, request_sha256: digest, state: 'processing', attempt_token: 'attempt-1' };
      rows.set(key, claimed);
      return { kind: 'claimed', row: claimed, attempt_token: 'attempt-1' };
    },
    async succeed(normalized, _attempt, receipt) {
      const key = `${normalized.repo}:${normalized.idempotency_key}`;
      rows.set(key, { ...rows.get(key), state: 'succeeded', receipt });
    },
    async abandon(normalized) { rows.delete(`${normalized.repo}:${normalized.idempotency_key}`); },
  };
}

export async function runGithubProductionPromotionTests() {
  const results = [];
  async function test(name, fn) { try { await fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); } }

  await test('promotion advances production to the existing dev commit only', async () => {
    const api = github();
    const result = await promoteGithubProduction(request(), { github: api, branchRoles: roles(), receipts: memoryReceipts() });
    assert(result.ok === true && result.new_production_head === B, 'promotion did not succeed');
    assert(api.state.updates.length === 1, 'expected one ref update');
    assert(api.state.updates[0].branch === 'main' && api.state.updates[0].sha === B, 'wrong ref update');
  });

  await test('stale development head rejects before mutation', async () => {
    const api = github(); api.state.dev = C;
    const result = await promoteGithubProduction(request(), { github: api, branchRoles: roles(), receipts: memoryReceipts() });
    assert(result.error === 'GITHUB_PRODUCTION_PROMOTION_STATE_CHANGED', `unexpected ${result.error}`);
    assert(api.state.updates.length === 0, 'stale dev mutated production');
  });

  await test('stale production head rejects before mutation', async () => {
    const api = github(); api.state.main = C;
    const result = await promoteGithubProduction(request(), { github: api, branchRoles: roles(), receipts: memoryReceipts() });
    assert(result.error === 'GITHUB_PRODUCTION_PROMOTION_STATE_CHANGED', `unexpected ${result.error}`);
    assert(api.state.updates.length === 0, 'stale production mutated');
  });

  await test('candidate must be exact current dev head before verification lookup', async () => {
    const api = github({
      async getWorkflowRun() { throw new Error('verification lookup must not run for a non-dev candidate'); },
    });
    const result = await promoteGithubProduction(request({ candidate_sha: C }), { github: api, branchRoles: roles(), receipts: memoryReceipts() });
    assert(result.error === 'GITHUB_PRODUCTION_PROMOTION_CANDIDATE_CHANGED', `unexpected ${result.error}`);
    assert(api.state.updates.length === 0, 'non-dev candidate mutated');
  });

  await test('verification must be successful dev push for exact candidate', async () => {
    for (const patch of [
      { event: 'workflow_dispatch' },
      { head_branch: 'main' },
      { head_sha: C },
      { status: 'in_progress', conclusion: null },
      { conclusion: 'failure' },
      { path: '.github/workflows/other.yml' },
    ]) {
      const api = github({ async getWorkflowRun() { return { id: 12345, path: '.github/workflows/exact-revision-v8.yml', event: 'push', head_branch: 'dev', head_sha: B, status: 'completed', conclusion: 'success', ...patch }; } });
      const result = await promoteGithubProduction(request(), { github: api, branchRoles: roles(), receipts: memoryReceipts() });
      assert(result.error === 'GITHUB_PRODUCTION_PROMOTION_VERIFICATION_REQUIRED', `accepted invalid verification ${JSON.stringify(patch)}`);
      assert(api.state.updates.length === 0, 'invalid verification mutated');
    }
  });

  await test('non fast forward production movement rejects', async () => {
    const api = github({ async compare() { return { status: 'diverged' }; } });
    const result = await promoteGithubProduction(request(), { github: api, branchRoles: roles(), receipts: memoryReceipts() });
    assert(result.error === 'GITHUB_PRODUCTION_PROMOTION_NON_FAST_FORWARD', `unexpected ${result.error}`);
    assert(api.state.updates.length === 0, 'diverged candidate mutated');
  });

  await test('same idempotency request replays without a second mutation', async () => {
    const api = github(); const receipts = memoryReceipts();
    const first = await promoteGithubProduction(request(), { github: api, branchRoles: roles(), receipts });
    const second = await promoteGithubProduction(request(), { github: api, branchRoles: roles(), receipts });
    assert(first.ok === true && second.ok === true, 'replay failed');
    assert(second.idempotent_replay === true, 'replay not identified');
    assert(api.state.updates.length === 1, 'replay repeated ref update');
  });

  await test('idempotency key cannot bind a different promotion', async () => {
    const api = github(); const receipts = memoryReceipts();
    await promoteGithubProduction(request(), { github: api, branchRoles: roles(), receipts });
    const result = await promoteGithubProduction(request({ candidate_sha: C, observed_development_head: C }), { github: api, branchRoles: roles(), receipts });
    assert(result.error === 'IDEMPOTENCY_CONFLICT', `unexpected ${result.error}`);
  });

  await test('already identical production returns verified no-change receipt', async () => {
    const api = github(); api.state.main = B;
    const result = await promoteGithubProduction(request({ observed_production_head: B }), { github: api, branchRoles: roles(), receipts: memoryReceipts() });
    assert(result.ok === true && result.changed === false, 'identical production did not no-op');
    assert(api.state.updates.length === 0, 'identical production updated ref');
  });

  return { ok: results.every(result => result.ok), passed: results.filter(result => result.ok).length, total: results.length, results };
}
