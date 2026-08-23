import {
  classifyPortfolioArtifacts,
  normalizePortfolioActionsStorageRequest,
  reconcilePortfolioActionsStorage,
} from 'lib/portfolio-actions-storage.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }
function store(rows) { return { list: async () => rows }; }

export async function runPortfolioActionsStorageTests() {
  const results = [];
  results.push(await run('request normalization is bounded and defaults to dry run', async () => {
    const normalized = normalizePortfolioActionsStorageRequest({});
    assert(normalized.mode === 'dry_run', 'default mode changed');
    assert(normalized.retention_days === 30, 'default retention changed');
    let rejected = false;
    try { normalizePortfolioActionsStorageRequest({ mode: 'apply', repo: 'owner/repo' }); } catch { rejected = true; }
    assert(rejected, 'unknown fields were accepted');
  }));
  results.push(await run('classification protects unknown evidence and retains newest coverage', async () => {
    const classified = classifyPortfolioArtifacts([
      { id: 3, name: 'repository-verification-coverage', size_in_bytes: 30, expired: false, created_at: '2026-08-03T00:00:00Z' },
      { id: 2, name: 'repository-verification-coverage', size_in_bytes: 20, expired: true, created_at: '2026-08-02T00:00:00Z' },
      { id: 1, name: 'release-bundle', size_in_bytes: 1000, expired: false, created_at: '2026-08-01T00:00:00Z' },
    ]);
    assert(JSON.stringify(classified.artifact_ids) === JSON.stringify([2]), 'wrong deletion candidate');
    assert(classified.retained.length === 1 && classified.retained[0].id === 3, 'newest coverage was not retained');
    assert(classified.protected.length === 1 && classified.protected[0].id === 1, 'unknown evidence was not protected');
    assert(classified.retention_safe === false, 'retention was marked safe with protected evidence');
  }));
  results.push(await run('classification deletes expired unknown artifacts but still protects live unknown evidence', async () => {
    const classified = classifyPortfolioArtifacts([
      { id: 5, name: 'release-bundle', size_in_bytes: 500, expired: false, created_at: '2026-08-03T00:00:00Z' },
      { id: 4, name: 'ljh-250-python312', size_in_bytes: 125309292, expired: true, created_at: '2026-08-02T00:00:00Z' },
    ]);
    assert(JSON.stringify(classified.artifact_ids) === JSON.stringify([4]), 'expired unknown artifact was not selected');
    assert(classified.candidates[0]?.deletion_reason === 'expired_by_github', 'expired artifact deletion reason changed');
    assert(classified.protected.length === 1 && classified.protected[0].id === 5, 'live unknown evidence was not protected');
    assert(classified.retention_safe === false, 'live protected evidence should still prevent retention mutation');
  }));
  results.push(await run('dry run skips disposed repositories and reports exact candidates', async () => {
    const calls = [];
    const storageCommand = async (input) => {
      calls.push(input);
      return { ok: true, artifact_count: 2, total_size_in_bytes: 30, live_size_in_bytes: 20, artifacts: [
        { id: 11, name: 'node-coverage', size_in_bytes: 20, expired: false, created_at: '2026-08-03T00:00:00Z' },
        { id: 10, name: 'node-coverage', size_in_bytes: 10, expired: true, created_at: '2026-08-02T00:00:00Z' },
      ] };
    };
    const result = await reconcilePortfolioActionsStorage({ mode: 'dry_run' }, { store: store([
      { repository: 'owner/active', disposition: 'ACTIVE', github_archived: false },
      { repository: 'owner/archived', disposition: 'ARCHIVED', github_archived: true },
    ]), storageCommand });
    assert(result.ok === true, 'dry run failed');
    assert(calls.length === 1 && calls[0].operation === 'inspect', 'dry run performed mutation or inspected disposed work');
    assert(result.repositories[0].candidate_artifact_ids[0] === 10, 'candidate report changed');
    assert(result.skipped_repository_count === 1, 'disposed repository was not skipped');
  }));
  results.push(await run('apply is idempotent and only deletes selected reproducible artifacts', async () => {
    let artifacts = [
      { id: 21, name: 'node-coverage', size_in_bytes: 20, expired: false, created_at: '2026-08-03T00:00:00Z' },
      { id: 20, name: 'node-coverage', size_in_bytes: 10, expired: true, created_at: '2026-08-02T00:00:00Z' },
      { id: 19, name: 'release-bundle', size_in_bytes: 500, expired: false, created_at: '2026-08-01T00:00:00Z' },
    ];
    const storageCommand = async (input) => {
      if (input.operation === 'inspect') return { ok: true, artifact_count: artifacts.length, total_size_in_bytes: artifacts.reduce((s,x)=>s+x.size_in_bytes,0), live_size_in_bytes: artifacts.filter(x=>!x.expired).reduce((s,x)=>s+x.size_in_bytes,0), artifacts: [...artifacts] };
      if (input.operation === 'delete_artifacts') {
        const selected = artifacts.filter((item) => input.artifact_ids.includes(item.id));
        artifacts = artifacts.filter((item) => !input.artifact_ids.includes(item.id));
        return { ok: true, outcome: 'completed', deleted_count: selected.length, already_absent_count: 0, reclaimed_size_in_bytes: selected.reduce((s,x)=>s+x.size_in_bytes,0) };
      }
      throw new Error(`unexpected operation ${input.operation}`);
    };
    const options = { store: store([{ repository: 'owner/active', disposition: 'ACTIVE', github_archived: false }]), storageCommand };
    const first = await reconcilePortfolioActionsStorage({ mode: 'apply' }, options);
    const second = await reconcilePortfolioActionsStorage({ mode: 'apply' }, options);
    assert(first.ok === true && first.deleted_artifact_count === 1, 'first apply did not delete one redundant artifact');
    assert(second.ok === true && second.deleted_artifact_count === 0, 'second apply was not idempotent');
    assert(artifacts.some((item) => item.id === 19), 'protected evidence was deleted');
  }));
  results.push(await run('safe repositories reconcile retention and partial failures do not stop siblings', async () => {
    const calls = [];
    const storageCommand = async (input) => {
      calls.push(input);
      if (input.repo === 'owner/fail') return { ok: false, error: 'GITHUB_UPSTREAM_ERROR', message: 'boom', may_have_mutated: false };
      if (input.operation === 'inspect') return { ok: true, artifact_count: 1, total_size_in_bytes: 20, live_size_in_bytes: 20, artifacts: [{ id: 31, name: 'node-coverage', size_in_bytes: 20, expired: false, created_at: '2026-08-03T00:00:00Z' }] };
      if (input.operation === 'set_retention') return { ok: true, outcome: 'updated', current_days: input.days };
      throw new Error(`unexpected operation ${input.operation}`);
    };
    const result = await reconcilePortfolioActionsStorage({ mode: 'apply', retention_days: 14 }, { store: store([
      { repository: 'owner/fail', disposition: 'ACTIVE', github_archived: false },
      { repository: 'owner/good', disposition: 'MAINTENANCE', github_archived: false },
    ]), storageCommand });
    assert(result.ok === false && result.outcome === 'partial_failure', 'partial failure was not reported');
    assert(result.failed_repository_count === 1, 'failed repository count changed');
    assert(calls.some((call) => call.repo === 'owner/good' && call.operation === 'set_retention' && call.days === 14), 'safe retention was not reconciled');
  }));
  return { ok: results.every((result) => result.ok), passed: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, tests: results };
}
