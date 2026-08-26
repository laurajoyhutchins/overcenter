import { githubAppPermissionProfile } from 'lib/github-app-auth.js';
import {
  githubActionsStorageInputSchema,
  inspectGithubActionsStorage,
  selectRedundantCoverageArtifacts,
  deleteGithubActionsArtifacts,
  deleteGithubActionsCaches,
  setGithubActionsRetention,
  normalizeGithubActionsStorageRequest,
} from 'lib/github-actions-storage.js';

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

async function run(name, fn) {
  try { await fn(); return { name, ok: true }; }
  catch (error) { return { name, ok: false, error: String(error?.message || error) }; }
}

function client(handler) {
  return { call: (name, options) => handler(name, options) };
}

export async function runGithubActionsStorageTests() {
  const results = [];

  results.push(await run('request normalization keeps operations narrow and exact', async () => {
    const inspect = normalizeGithubActionsStorageRequest({ repo: 'owner/repo', operation: 'inspect' });
    assert(inspect.operation === 'inspect', 'inspect operation changed');
    const deletion = normalizeGithubActionsStorageRequest({ repo: 'owner/repo', operation: 'delete_artifacts', artifact_ids: [1, 2] });
    assert(deletion.artifact_ids.length === 2, 'artifact ids were not preserved');
    const cacheDeletion = normalizeGithubActionsStorageRequest({ repo: 'owner/repo', operation: 'delete_caches', cache_ids: [3, 4] });
    assert(cacheDeletion.cache_ids.length === 2, 'cache ids were not preserved');
    const selection = normalizeGithubActionsStorageRequest({ repo: 'owner/repo', operation: 'select_redundant_coverage' });
    assert(selection.operation === 'select_redundant_coverage', 'selection operation changed');
    const retention = normalizeGithubActionsStorageRequest({ repo: 'owner/repo', operation: 'set_retention', days: 14 });
    assert(retention.days === 14, 'retention days were not preserved');
    let rejected = false;
    try { normalizeGithubActionsStorageRequest({ repo: 'owner/repo', operation: 'delete_artifacts', artifact_ids: [1], days: 14 }); } catch { rejected = true; }
    assert(rejected, 'cross-operation fields were accepted');
  }));

  results.push(await run('MCP schema exposes cache inspection and exact-id cache deletion without broadening authority', async () => {
    const schema = githubActionsStorageInputSchema;
    const operations = schema?.properties?.operation?.enum || [];
    assert(operations.includes('inspect'), 'inspect operation missing from MCP schema');
    assert(operations.includes('delete_caches'), 'delete_caches operation missing from MCP schema');
    assert(schema?.properties?.cache_ids?.items?.type === 'integer', 'cache_ids exact-id schema missing');
  }));

  results.push(await run('permission profiles stay split by capability', async () => {
    assert(JSON.stringify(githubAppPermissionProfile('actions_storage_read')) === JSON.stringify({ actions: 'read' }), 'inspect permission is not actions read only');
    assert(JSON.stringify(githubAppPermissionProfile('actions_storage_delete')) === JSON.stringify({ actions: 'write' }), 'delete permission is not actions write only');
    assert(JSON.stringify(githubAppPermissionProfile('actions_retention')) === JSON.stringify({ administration: 'write' }), 'retention permission is not administration write only');
  }));

  results.push(await run('inspect paginates and totals live artifact bytes', async () => {
    const calls = [];
    const apiClient = client(async (_name, options) => {
      calls.push(options);
      const page = Number(options.query.page);
      if (page === 1) return { status: 200, headers: {}, body: { total_count: 3, artifacts: [
        { id: 11, name: 'a', size_in_bytes: 100, expired: false, created_at: '2026-08-01T00:00:00Z', expires_at: '2026-09-01T00:00:00Z', workflow_run: { id: 101 } },
        { id: 12, name: 'b', size_in_bytes: 50, expired: true, created_at: '2026-07-01T00:00:00Z', expires_at: '2026-08-01T00:00:00Z', workflow_run: { id: 102 } },
      ] } };
      return { status: 200, headers: {}, body: { total_count: 3, artifacts: [
        { id: 13, name: 'c', size_in_bytes: 200, expired: false, created_at: '2026-08-02T00:00:00Z', expires_at: '2026-09-02T00:00:00Z', workflow_run: { id: 103 } },
      ] } };
    });
    const result = await inspectGithubActionsStorage({ repo: 'owner/repo', operation: 'inspect' }, { apiClient });
    assert(result.ok === true, 'inspect failed');
    assert(result.artifact_count === 3, 'artifact count mismatch');
    assert(result.live_artifact_count === 2, 'live artifact count mismatch');
    assert(result.live_size_in_bytes === 300, 'live byte total mismatch');
    assert(calls.filter((call) => call.path.endsWith('/actions/artifacts')).length === 2, 'artifact pagination did not stop at total_count');
  }));

  results.push(await run('inspect includes dependency caches as a distinct Actions storage surface', async () => {
    const apiClient = client(async (_name, options) => {
      if (options.path.endsWith('/actions/artifacts')) {
        return { status: 200, headers: {}, body: { total_count: 1, artifacts: [
          { id: 21, name: 'evidence', size_in_bytes: 100, expired: false, created_at: '2026-08-02T00:00:00Z', expires_at: '2026-09-02T00:00:00Z' },
        ] } };
      }
      if (options.path.endsWith('/actions/caches')) {
        return { status: 200, headers: {}, body: { total_count: 2, actions_caches: [
          { id: 41, key: 'go-linux-a', ref: 'refs/heads/main', version: 'v1', size_in_bytes: 300, created_at: '2026-08-01T00:00:00Z', last_accessed_at: '2026-08-03T00:00:00Z' },
          { id: 42, key: 'go-linux-b', ref: 'refs/heads/main', version: 'v2', size_in_bytes: 400, created_at: '2026-08-02T00:00:00Z', last_accessed_at: '2026-08-04T00:00:00Z' },
        ] } };
      }
      throw new Error(`unexpected path ${options.path}`);
    });
    const result = await inspectGithubActionsStorage({ repo: 'owner/repo', operation: 'inspect' }, { apiClient });
    assert(result.ok === true, 'inspect failed');
    assert(result.artifact_size_in_bytes === 100, 'artifact byte total mismatch');
    assert(result.cache_count === 2, 'cache count mismatch');
    assert(result.cache_size_in_bytes === 700, 'cache byte total mismatch');
    assert(result.actions_storage_size_in_bytes === 800, 'combined Actions storage total mismatch');
    assert(result.caches.length === 2 && result.caches[0].key === 'go-linux-a', 'cache evidence missing');
  }));

  results.push(await run('coverage selector keeps only newest artifact per coverage name', async () => {
    const apiClient = client(async (_name, options) => {
      assert(options.method === 'GET', 'selector attempted mutation');
      return { status: 200, headers: {}, body: { total_count: 5, artifacts: [
        { id: 31, name: 'repository-verification-coverage', size_in_bytes: 100, expired: false, created_at: '2026-08-06T00:00:00Z' },
        { id: 32, name: 'repository-verification-coverage', size_in_bytes: 90, expired: false, created_at: '2026-08-05T00:00:00Z' },
        { id: 33, name: 'node-coverage', size_in_bytes: 80, expired: false, created_at: '2026-08-04T00:00:00Z' },
        { id: 34, name: 'node-coverage', size_in_bytes: 70, expired: true, created_at: '2026-08-03T00:00:00Z' },
        { id: 35, name: 'other-evidence', size_in_bytes: 1000, expired: false, created_at: '2026-08-02T00:00:00Z' },
      ] } };
    });
    const result = await selectRedundantCoverageArtifacts({ repo: 'owner/repo', operation: 'select_redundant_coverage' }, { apiClient });
    assert(result.ok === true, 'selection failed');
    assert(JSON.stringify(result.artifact_ids) === JSON.stringify([32, 34]), 'selector did not choose only redundant coverage ids');
    assert(result.selected_size_in_bytes === 160, 'selected byte total mismatch');
    assert(result.retained.length === 2 && result.retained.some((item) => item.id === 31) && result.retained.some((item) => item.id === 33), 'newest coverage artifacts were not retained');
  }));

  results.push(await run('delete removes only explicit ids and treats missing ids idempotently', async () => {
    const calls = [];
    const apiClient = client(async (_name, options) => {
      calls.push(options);
      if (options.method === 'GET' && options.path.endsWith('/21')) return { status: 200, headers: {}, body: { id: 21, name: 'old', size_in_bytes: 123, expired: false } };
      if (options.method === 'DELETE' && options.path.endsWith('/21')) return { status: 204, headers: {}, body: null };
      if (options.method === 'GET' && options.path.endsWith('/22')) return { status: 404, headers: {}, body: { message: 'Not Found' } };
      throw new Error(`unexpected call ${options.method} ${options.path}`);
    });
    const result = await deleteGithubActionsArtifacts({ repo: 'owner/repo', operation: 'delete_artifacts', artifact_ids: [21, 22] }, { apiClient });
    assert(result.ok === true, 'delete batch failed');
    assert(result.deleted_count === 1, 'deleted count mismatch');
    assert(result.already_absent_count === 1, 'already absent count mismatch');
    assert(result.reclaimed_size_in_bytes === 123, 'reclaimed byte evidence mismatch');
    assert(calls.filter((call) => call.method === 'DELETE').length === 1, 'delete ran for an absent artifact');
  }));

  results.push(await run('cache delete removes only explicit ids and reports reclaimed bytes from observed cache state', async () => {
    const calls = [];
    const apiClient = client(async (_name, options) => {
      calls.push(options);
      if (options.method === 'GET' && options.path.endsWith('/actions/caches')) return { status: 200, headers: {}, body: { total_count: 1, actions_caches: [
        { id: 41, key: 'go-linux-a', ref: 'refs/heads/main', version: 'v1', size_in_bytes: 300 },
      ] } };
      if (options.method === 'DELETE' && options.path.endsWith('/41')) return { status: 204, headers: {}, body: null };
      throw new Error(`unexpected call ${options.method} ${options.path}`);
    });
    const result = await deleteGithubActionsCaches({ repo: 'owner/repo', operation: 'delete_caches', cache_ids: [41, 42] }, { apiClient });
    assert(result.ok === true, 'cache delete batch failed');
    assert(result.deleted_count === 1, 'cache deleted count mismatch');
    assert(result.already_absent_count === 1, 'cache already absent count mismatch');
    assert(result.reclaimed_size_in_bytes === 300, 'cache reclaimed byte evidence mismatch');
    assert(calls.filter((call) => call.method === 'DELETE').length === 1, 'delete ran for an absent cache');
  }));

  results.push(await run('retention update is read-write-read verified', async () => {
    const calls = [];
    const apiClient = client(async (_name, options) => {
      calls.push(options);
      if (calls.length === 1) return { status: 200, headers: {}, body: { days: 90, maximum_allowed_days: 400 } };
      if (calls.length === 2) return { status: 204, headers: {}, body: null };
      return { status: 200, headers: {}, body: { days: 14, maximum_allowed_days: 400 } };
    });
    const result = await setGithubActionsRetention({ repo: 'owner/repo', operation: 'set_retention', days: 14 }, { apiClient });
    assert(result.ok === true && result.outcome === 'updated', 'retention was not updated');
    assert(result.previous_days === 90 && result.current_days === 14, 'retention evidence mismatch');
    assert(calls[1].method === 'PUT' && calls[1].body.days === 14, 'retention write was wrong');
  }));

  return {
    ok: results.every((result) => result.ok),
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    tests: results,
  };
}