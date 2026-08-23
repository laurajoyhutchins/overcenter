import {
  SOURCE_SYNC_BRANCH,
  SOURCE_SYNC_PROJECT,
  SOURCE_SYNC_REPO,
  gitBlobSha,
  isSyncableSourcePath,
  materializePullPlan,
  materializeSourceRecords,
  planPullSync,
  planPushSync,
  verifyGitProjection,
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

export async function runSourceSyncRegressionTests() {
  const results = [];

  results.push(await run('source coordinates stay fixed', async () => {
    check(SOURCE_SYNC_PROJECT === 'proj_I6FSm85xrY7T', 'project drifted');
    check(SOURCE_SYNC_REPO === 'laurajoyhutchins/busbar', 'repo drifted');
    check(SOURCE_SYNC_BRANCH === 'main', 'branch drifted');
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

  results.push(await run('push plan creates updates deletes and preserves GitHub-only files', async () => {
    const same = await source('lib/same.js', 'same\n');
    const old = await source('lib/update.js', 'old\n');
    const plan = await planPushSync({
      expected_hatchable_version: 198,
      observed_hatchable_version: 198,
      expected_github_head: HEAD,
      observed_github_head: HEAD,
      hatchable_files: [
        { path: 'lib/same.js', content: 'same\n' },
        { path: 'lib/update.js', content: 'new\n' },
        { path: 'lib/create.js', content: 'create\n' },
      ],
      github_tree: [
        { path: 'lib/same.js', type: 'blob', sha: same.git_blob_sha },
        { path: 'lib/update.js', type: 'blob', sha: old.git_blob_sha },
        { path: 'lib/delete.js', type: 'blob', sha: await gitBlobSha('delete\n') },
        { path: '.github/workflows/ci.yml', type: 'blob', sha: await gitBlobSha('keep\n') },
      ],
    });
    check(plan.outcome === 'mutation_required', 'push should require mutation');
    check(JSON.stringify(plan.changed_paths) === JSON.stringify([
      { path: 'lib/create.js', operation: 'create' },
      { path: 'lib/delete.js', operation: 'delete' },
      { path: 'lib/update.js', operation: 'update' },
    ]), `unexpected changes ${JSON.stringify(plan.changed_paths)}`);
  }));

  results.push(await run('push plan rejects stale Hatchable version', async () => {
    let error = null;
    try { await planPushSync({ expected_hatchable_version: 198, observed_hatchable_version: 199, expected_github_head: HEAD, observed_github_head: HEAD, hatchable_files: [], github_tree: [] }); }
    catch (caught) { error = caught; }
    check(error?.code === 'HATCHABLE_VERSION_MISMATCH', `unexpected ${error?.code}`);
  }));

  results.push(await run('push plan rejects stale GitHub head', async () => {
    let error = null;
    try { await planPushSync({ expected_hatchable_version: 198, observed_hatchable_version: 198, expected_github_head: HEAD, observed_github_head: '2222222222222222222222222222222222222222', hatchable_files: [], github_tree: [] }); }
    catch (caught) { error = caught; }
    check(error?.code === 'GITHUB_HEAD_MISMATCH', `unexpected ${error?.code}`);
  }));

  results.push(await run('no-op push is recognized without mutation', async () => {
    const record = await source('lib/a.js', 'a\n');
    const plan = await planPushSync({ expected_hatchable_version: 198, observed_hatchable_version: 198, expected_github_head: HEAD, observed_github_head: HEAD, hatchable_files: [{ path: 'lib/a.js', content: 'a\n' }], github_tree: [{ path: 'lib/a.js', type: 'blob', sha: record.git_blob_sha }] });
    check(plan.outcome === 'already_synced' && plan.changes.length === 0, 'no-op was not recognized');
  }));

  results.push(await run('pull plan fetches only changed blobs and deletes stale Hatchable paths', async () => {
    const same = await source('lib/same.js', 'same\n');
    const plan = await planPullSync({
      expected_hatchable_version: 198,
      observed_hatchable_version: 198,
      expected_github_head: HEAD,
      observed_github_head: HEAD,
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
    check(JSON.stringify(plan.fetch) === JSON.stringify([
      { path: 'lib/create.js', expected_blob_sha: await gitBlobSha('create\n') },
      { path: 'lib/update.js', expected_blob_sha: await gitBlobSha('new\n') },
    ]), `unexpected fetch ${JSON.stringify(plan.fetch)}`);
    check(JSON.stringify(plan.deletes) === JSON.stringify(['lib/delete.js']), `unexpected deletes ${JSON.stringify(plan.deletes)}`);
  }));

  results.push(await run('materialized pull verifies fetched Git blob identities', async () => {
    const plan = await planPullSync({ expected_hatchable_version: 198, observed_hatchable_version: 198, expected_github_head: HEAD, observed_github_head: HEAD, hatchable_files: [], github_tree: [{ path: 'lib/a.js', type: 'blob', sha: await gitBlobSha('right\n') }] });
    let error = null;
    try { await materializePullPlan(plan, [{ path: 'lib/a.js', content: 'wrong\n' }]); }
    catch (caught) { error = caught; }
    check(error?.code === 'SOURCE_SYNC_GIT_BLOB_MISMATCH', `unexpected ${error?.code}`);
  }));

  results.push(await run('materialized pull produces exact writes deletes and target manifest', async () => {
    const plan = await planPullSync({ expected_hatchable_version: 198, observed_hatchable_version: 198, expected_github_head: HEAD, observed_github_head: HEAD, hatchable_files: [{ path: 'lib/old.js', content: 'old\n' }], github_tree: [{ path: 'lib/new.js', type: 'blob', sha: await gitBlobSha('new\n') }] });
    const materialized = await materializePullPlan(plan, [{ path: 'lib/new.js', content: 'new\n' }]);
    check(JSON.stringify(materialized.writes) === JSON.stringify([{ path: 'lib/new.js', content: 'new\n' }]), 'writes mismatch');
    check(JSON.stringify(materialized.deletes) === JSON.stringify(['lib/old.js']), 'deletes mismatch');
    check(materialized.target_records.length === 1 && materialized.target_records[0].path === 'lib/new.js', 'target records mismatch');
    check(/^[0-9a-f]{64}$/.test(materialized.target_manifest_sha256), 'target manifest missing');
  }));

  results.push(await run('Git verification detects projection drift', async () => {
    const records = await materializeSourceRecords([{ path: 'lib/a.js', content: 'a\n' }]);
    const verification = verifyGitProjection(records, [{ path: 'lib/a.js', type: 'blob', sha: await gitBlobSha('b\n') }]);
    check(verification.ok === false && verification.differences[0]?.kind === 'blob_mismatch', 'Git drift not detected');
  }));

  results.push(await run('Hatchable verification detects projection drift', async () => {
    const records = await materializeSourceRecords([{ path: 'lib/a.js', content: 'a\n' }]);
    const verification = await verifyHatchableProjection(records, [{ path: 'lib/a.js', content: 'b\n' }]);
    check(verification.ok === false && verification.differences[0]?.kind === 'content_mismatch', 'Hatchable drift not detected');
  }));

  return { ok: results.every(result => result.ok), passed: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length, results };
}