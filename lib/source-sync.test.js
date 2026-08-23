import * as sourceSync from 'lib/source-sync.js';
import {
  SOURCE_SYNC_AUTHORITY,
  SOURCE_SYNC_BRANCH,
  SOURCE_SYNC_PROJECT,
  SOURCE_SYNC_REPO,
  gitBlobSha,
  isSyncableSourcePath,
  materializePullPlan,
  materializeSourceRecords,
  planPullSync,
  verifyHatchableProjection,
} from 'lib/source-sync.js';

const HEAD = '1111111111111111111111111111111111111111';

function check(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

async function run(name, fn) {
  try { await fn(); return { name, ok: true }; }
  catch (error) { return { name, ok: false, error: String(error?.message || error) }; }
}

async function source(path, content) {
  const [record] = await materializeSourceRecords([{ path, content }]);
  return record;
}

function coordinates(overrides = {}) {
  return {
    expected_hatchable_version: 198,
    observed_hatchable_version: 198,
    expected_github_head: HEAD,
    observed_github_head: HEAD,
    ...overrides,
  };
}

export async function runSourceSyncRegressionTests() {
  const results = [];

  results.push(await run('source coordinates and authority stay fixed', async () => {
    check(SOURCE_SYNC_PROJECT === 'proj_I6FSm85xrY7T', 'project drifted');
    check(SOURCE_SYNC_REPO === 'laurajoyhutchins/busbar', 'repo drifted');
    check(SOURCE_SYNC_BRANCH === 'main', 'branch drifted');
    check(SOURCE_SYNC_AUTHORITY === 'github', 'GitHub is not declared as source authority');
  }));

  results.push(await run('syncable path filter preserves repository-only surfaces', async () => {
    check(isSyncableSourcePath('lib/a.js'), 'lib path excluded');
    check(isSyncableSourcePath('hatchable.toml'), 'config excluded');
    check(!isSyncableSourcePath('.github/workflows/ci.yml'), '.github should stay GitHub-only');
    check(!isSyncableSourcePath('AGENTS.md'), 'virtual/root AGENTS path should not synchronize');
  }));

  results.push(await run('Git blob identity matches canonical empty blob', async () => {
    check(await gitBlobSha('') === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'empty Git blob SHA mismatch');
  }));

  results.push(await run('source sync exports no reverse GitHub publication planner', async () => {
    check(!Object.prototype.hasOwnProperty.call(sourceSync, 'planPushSync'), 'reverse push planner remains exported');
    check(!Object.prototype.hasOwnProperty.call(sourceSync, 'verifyGitProjection'), 'GitHub is still modeled as a projection');
  }));

  results.push(await run('GitHub-authoritative plan diagnoses runtime drift', async () => {
    const same = await source('lib/same.js', 'same\n');
    const plan = await planPullSync({
      ...coordinates(),
      hatchable_files: [
        { path: 'lib/same.js', content: 'same\n' },
        { path: 'lib/update.js', content: 'old\n' },
        { path: 'lib/delete.js', content: 'delete\n' },
      ],
      github_tree: [
        { path: 'lib/same.js', type: 'blob', sha: same.git_blob_sha },
        { path: 'lib/update.js', type: 'blob', sha: await gitBlobSha('new\n') },
        { path: 'lib/create.js', type: 'blob', sha: await gitBlobSha('create\n') },
        { path: '.github/workflows/ci.yml', type: 'blob', sha: await gitBlobSha('keep\n') },
      ],
    });
    check(plan.authority === 'github' && plan.direction === 'github_to_runtime', 'plan authority/direction is wrong');
    check(plan.outcome === 'materialization_required', 'drift should require materialization');
    check(JSON.stringify(plan.fetch) === JSON.stringify([
      { path: 'lib/create.js', expected_blob_sha: await gitBlobSha('create\n') },
      { path: 'lib/update.js', expected_blob_sha: await gitBlobSha('new\n') },
    ]), `unexpected fetch ${JSON.stringify(plan.fetch)}`);
    check(JSON.stringify(plan.deletes) === JSON.stringify(['lib/delete.js']), `unexpected deletes ${JSON.stringify(plan.deletes)}`);
    check(JSON.stringify(plan.runtime_drift.map(({ path, kind, action }) => ({ path, kind, action }))) === JSON.stringify([
      { path: 'lib/create.js', kind: 'missing_runtime_path', action: 'fetch' },
      { path: 'lib/delete.js', kind: 'stale_runtime_path', action: 'delete' },
      { path: 'lib/update.js', kind: 'runtime_content_mismatch', action: 'fetch' },
    ]), `unexpected drift ${JSON.stringify(plan.runtime_drift)}`);
  }));

  results.push(await run('runtime drift never produces GitHub mutations', async () => {
    const plan = await planPullSync({
      ...coordinates(),
      hatchable_files: [{ path: 'lib/a.js', content: 'runtime\n' }],
      github_tree: [{ path: 'lib/a.js', type: 'blob', sha: await gitBlobSha('github\n') }],
    });
    check(plan.fetch.length === 1, 'GitHub content should be fetched to repair runtime drift');
    check(!Object.prototype.hasOwnProperty.call(plan, 'changes'), 'plan exposes reverse changes');
    check(!Object.prototype.hasOwnProperty.call(plan, 'github_mutations'), 'plan exposes GitHub mutations');
  }));

  results.push(await run('materialization rejects stale Hatchable runtime version', async () => {
    let error = null;
    try {
      await planPullSync({
        ...coordinates({ observed_hatchable_version: 199 }),
        hatchable_files: [],
        github_tree: [],
      });
    } catch (caught) { error = caught; }
    check(error?.code === 'HATCHABLE_VERSION_MISMATCH', `unexpected ${error?.code}`);
  }));

  results.push(await run('materialization rejects stale GitHub head', async () => {
    let error = null;
    try {
      await planPullSync({
        ...coordinates({ observed_github_head: '2222222222222222222222222222222222222222' }),
        hatchable_files: [],
        github_tree: [],
      });
    } catch (caught) { error = caught; }
    check(error?.code === 'GITHUB_HEAD_MISMATCH', `unexpected ${error?.code}`);
  }));

  results.push(await run('no-op materialization is recognized without writes', async () => {
    const record = await source('lib/a.js', 'a\n');
    const plan = await planPullSync({
      ...coordinates(),
      hatchable_files: [{ path: 'lib/a.js', content: 'a\n' }],
      github_tree: [{ path: 'lib/a.js', type: 'blob', sha: record.git_blob_sha }],
    });
    check(plan.outcome === 'already_materialized', 'no-op was not recognized');
    check(plan.runtime_drift.length === 0 && plan.fetch.length === 0 && plan.deletes.length === 0, 'no-op contains mutations');
  }));

  results.push(await run('materialized plan verifies fetched Git blob identities', async () => {
    const plan = await planPullSync({
      ...coordinates(),
      hatchable_files: [],
      github_tree: [{ path: 'lib/a.js', type: 'blob', sha: await gitBlobSha('right\n') }],
    });
    let error = null;
    try { await materializePullPlan(plan, [{ path: 'lib/a.js', content: 'wrong\n' }]); }
    catch (caught) { error = caught; }
    check(error?.code === 'SOURCE_SYNC_GIT_BLOB_MISMATCH', `unexpected ${error?.code}`);
  }));

  results.push(await run('materialized plan produces exact writes deletes and target manifest', async () => {
    const plan = await planPullSync({
      ...coordinates(),
      hatchable_files: [{ path: 'lib/old.js', content: 'old\n' }],
      github_tree: [{ path: 'lib/new.js', type: 'blob', sha: await gitBlobSha('new\n') }],
    });
    const materialized = await materializePullPlan(plan, [{ path: 'lib/new.js', content: 'new\n' }]);
    check(JSON.stringify(materialized.writes) === JSON.stringify([{ path: 'lib/new.js', content: 'new\n' }]), 'writes mismatch');
    check(JSON.stringify(materialized.deletes) === JSON.stringify(['lib/old.js']), 'deletes mismatch');
    check(materialized.target_records.length === 1 && materialized.target_records[0].path === 'lib/new.js', 'target records mismatch');
    check(/^[0-9a-f]{64}$/.test(materialized.target_manifest_sha256), 'target manifest missing');
  }));

  results.push(await run('Hatchable runtime verification detects projection drift', async () => {
    const records = await materializeSourceRecords([{ path: 'lib/a.js', content: 'a\n' }]);
    const verification = await verifyHatchableProjection(records, [{ path: 'lib/a.js', content: 'b\n' }]);
    check(verification.ok === false && verification.differences[0]?.kind === 'content_mismatch', 'runtime drift not detected');
  }));

  return {
    ok: results.every(result => result.ok),
    passed: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
    results,
  };
}
