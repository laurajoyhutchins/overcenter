import {
  assertDevelopmentBase,
  assertOrdinaryWorkTarget,
  createRepositoryBranchRoleService,
  normalizeRepositoryBranchRoleBinding,
} from 'lib/repository-branch-roles.js';
import { bindProductionSourceCoordinates } from 'lib/production-source-sync.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function memoryStore() {
  const rows = new Map();
  return {
    async get(repository) { return rows.get(String(repository).toLowerCase()) || null; },
    async insert(binding) {
      const key = binding.repository.toLowerCase();
      if (rows.has(key)) return null;
      const row = { ...binding, created_at: '2026-08-27T00:00:00.000Z', updated_at: '2026-08-27T00:00:00.000Z' };
      rows.set(key, row);
      return row;
    },
  };
}

export async function runRepositoryBranchRoleTests() {
  const results = [];
  async function test(name, fn) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('development role is exactly dev', async () => {
    const binding = normalizeRepositoryBranchRoleBinding({
      repository: 'laurajoyhutchins/overcenter',
      development_branch: 'dev',
      production_branch: 'main',
      production_source_ref: 'runtime:production-source-materialization',
    });
    assert(binding.development_branch === 'dev', 'development branch drifted');
    assert(binding.production_branch === 'main', 'production branch drifted');
  });

  await test('development and production cannot alias', async () => {
    let code = null;
    try {
      normalizeRepositoryBranchRoleBinding({
        repository: 'laurajoyhutchins/overcenter',
        development_branch: 'dev',
        production_branch: 'dev',
        production_source_ref: 'runtime:test',
      });
    } catch (error) { code = error.code; }
    assert(code === 'REPOSITORY_BRANCH_ROLE_CONFLICT', `unexpected ${code}`);
  });

  await test('ensure is idempotent for the same binding', async () => {
    const service = createRepositoryBranchRoleService({ store: memoryStore() });
    const input = {
      repository: 'laurajoyhutchins/overcenter',
      development_branch: 'dev',
      production_branch: 'main',
      production_source_ref: 'runtime:test',
    };
    const first = await service.ensure(input);
    const second = await service.ensure(input);
    assert(first.changed === true, 'first ensure did not persist');
    assert(second.changed === false, 'identical ensure was not replay-safe');
  });

  await test('ensure rejects branch-role rewrites', async () => {
    const service = createRepositoryBranchRoleService({ store: memoryStore() });
    await service.ensure({ repository: 'laurajoyhutchins/overcenter', development_branch: 'dev', production_branch: 'main', production_source_ref: 'runtime:test' });
    let code = null;
    try {
      await service.ensure({ repository: 'laurajoyhutchins/overcenter', development_branch: 'dev', production_branch: 'release', production_source_ref: 'runtime:test' });
    } catch (error) { code = error.code; }
    assert(code === 'REPOSITORY_BRANCH_ROLE_CHANGED', `unexpected ${code}`);
  });

  await test('ordinary work cannot mutate managed role branches', async () => {
    const roles = { development_branch: 'dev', production_branch: 'main' };
    for (const branch of ['dev', 'main']) {
      let code = null;
      try { assertOrdinaryWorkTarget(branch, roles); } catch (error) { code = error.code; }
      assert(code === 'GITHUB_BRANCH_ROLE_VIOLATION', `${branch} was not rejected`);
    }
    assertOrdinaryWorkTarget('feat/self-hosting-promotion-boundary', roles);
  });

  await test('managed pull requests target dev only', async () => {
    const roles = { development_branch: 'dev', production_branch: 'main' };
    assertDevelopmentBase('dev', roles);
    let details = null;
    try { assertDevelopmentBase('main', roles); } catch (error) { details = { code: error.code, ...error.details }; }
    assert(details?.code === 'GITHUB_BRANCH_ROLE_VIOLATION', 'production base was not rejected');
    assert(details?.expected_base === 'dev', 'expected development base missing');
  });

  await test('production source sync derives main and rejects caller override', async () => {
    const roles = { development_branch:'dev', production_branch:'main' };
    const bound = bindProductionSourceCoordinates({ github_repository:'laurajoyhutchins/overcenter' }, roles);
    assert(bound.github_branch === 'main', 'production source branch was not derived');
    let code = null;
    try { bindProductionSourceCoordinates({ github_branch:'dev' }, roles); } catch (error) { code = error.code; }
    assert(code === 'SOURCE_SYNC_BRANCH_ROLE_VIOLATION', `unexpected ${code}`);
  });

  return { ok: results.every((result) => result.ok), passed: results.filter((result) => result.ok).length, total: results.length, results };
}
