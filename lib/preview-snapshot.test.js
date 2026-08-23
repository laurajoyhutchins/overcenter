import {
  derivePreviewSnapshot,
  previewVersionLabel,
  readPreviewSnapshot,
  renderPreviewPage,
} from './preview-snapshot.js';

function assert(value, message) { if (!value) throw new Error(message); }

export async function runPreviewSnapshotTests() {
  const tests = [];
  async function test(name, fn) {
    try { await fn(); tests.push({ name, ok: true }); }
    catch (error) { tests.push({ name, ok: false, error: String(error?.message || error) }); }
  }

  await test('derives a truthful healthy snapshot from authoritative counts', async () => {
    const snapshot = derivePreviewSnapshot({ version:277, scheduled_runs:2, interactive_runs:1, active_leases:2, recovery_pending:0 });
    assert(snapshot.version === 277, 'version was not preserved');
    assert(snapshot.execution.scheduled === 2 && snapshot.execution.interactive === 1, 'run modes drifted');
    assert(snapshot.busbar.runs === 3 && snapshot.busbar.leases === 2, 'runtime totals drifted');
    assert(snapshot.busbar.recovery_pending === 0 && snapshot.condition === 'healthy', 'healthy state was not derived');
    assert(snapshot.github.role === 'authority' && snapshot.linear.role === 'projection', 'authority roles drifted');
    assert(previewVersionLabel(snapshot) === 'v277', 'version label was not derived');
  });

  await test('keeps unavailable values unknown instead of fabricating zero', async () => {
    const snapshot = derivePreviewSnapshot({ version:null, scheduled_runs:null, interactive_runs:null, active_leases:null, recovery_pending:null });
    assert(snapshot.version === null, 'missing version was fabricated');
    assert(snapshot.busbar.runs === null && snapshot.busbar.leases === null, 'missing runtime counts were fabricated');
    assert(snapshot.busbar.recovery_pending === null && snapshot.condition === 'unknown', 'unknown recovery state was collapsed');
    assert(previewVersionLabel(snapshot) === 'v?', 'unknown version label was not explicit');
  });

  await test('marks unresolved indeterminate effects as recovery activity', async () => {
    const snapshot = derivePreviewSnapshot({ version:'278', scheduled_runs:0, interactive_runs:1, active_leases:1, recovery_pending:2 });
    assert(snapshot.version === 278, 'numeric version text was not normalized');
    assert(snapshot.busbar.recovery_pending === 2 && snapshot.condition === 'recovering', 'recovery state was not surfaced');
  });

  await test('canonical unhealthy conditions prevent a false healthy preview', async () => {
    const snapshot = derivePreviewSnapshot({
      version:279,
      scheduled_runs:0,
      interactive_runs:1,
      active_leases:0,
      recovery_pending:0,
      health_conditions:{ overdue_active_runs:1 },
    });
    assert(snapshot.busbar.recovery_pending === 1, 'canonical unhealthy count was not surfaced as recovery work');
    assert(snapshot.condition === 'recovering', 'preview reported healthy while canonical orchestration health was unhealthy');
  });

  await test('reads runtime state in one bounded query and version independently', async () => {
    const calls = [];
    const db = { query: async (sql) => { calls.push(sql); return { rows:[{ scheduled_runs:3, interactive_runs:2, active_leases:4, recovery_pending:1 }] }; } };
    const snapshot = await readPreviewSnapshot({ db, versionProvider:async()=>281 });
    assert(calls.length === 1, 'snapshot state was assembled through multiple database queries');
    assert(snapshot.execution.scheduled === 3 && snapshot.execution.interactive === 2, 'database state was not projected');
    assert(snapshot.busbar.runs === 5 && snapshot.busbar.leases === 4, 'database totals were not projected');
    assert(snapshot.version === 281 && snapshot.condition === 'recovering', 'version or recovery state was not projected');
  });

  await test('database degradation stays explicit while independent version remains available', async () => {
    const snapshot = await readPreviewSnapshot({ db:{ query:async()=>{ throw new Error('db unavailable'); } }, versionProvider:async()=>282 });
    assert(snapshot.version === 282, 'independent version source was discarded');
    assert(snapshot.busbar.runs === null && snapshot.busbar.leases === null && snapshot.condition === 'unknown', 'database failure fabricated runtime state');
  });

  await test('renders the stable architecture grammar without stale hard-coded version', async () => {
    const html = renderPreviewPage(derivePreviewSnapshot({ version:283, scheduled_runs:1, interactive_runs:2, active_leases:2, recovery_pending:0 }));
    for (const text of ['Busbar','scheduled','interactive','GitHub','authority','Linear','projection','Open dashboard','v283']) {
      assert(html.includes(text), `preview omitted ${text}`);
    }
    assert(!html.includes('v191'), 'stale hard-coded preview version survived');
    assert(html.includes('viewBox="0 0 420 238"'), 'stable SVG geometry is missing');
  });

  return { ok:tests.every(test=>test.ok), passed:tests.filter(test=>test.ok).length, failed:tests.filter(test=>!test.ok).length, tests };
}
