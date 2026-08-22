import { createScheduledExecutionContextService } from 'lib/scheduled-execution-context.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok:true }; } catch (error) { return { name, ok:false, error:String(error?.message || error) }; } }

class FakeRuns {
  constructor() { this.requests = []; this.rows = new Map(); }
  async start(input) {
    this.requests.push(JSON.parse(JSON.stringify(input)));
    const existing = this.rows.get(input.run_id);
    if (existing) return { ...existing, idempotent_replay:true };
    const row = { ...JSON.parse(JSON.stringify(input)), status:'active', started_at:'2026-08-21T15:12:03.000Z', idempotent_replay:false };
    this.rows.set(input.run_id, row);
    return row;
  }
}

export async function runScheduledExecutionContextTests() {
  const results = [];

  results.push(await run('scheduled bootstrap derives run cycle scope and retry identity from participant only', async () => {
    const runs = new FakeRuns();
    const service = createScheduledExecutionContextService({ runs, now:()=>'2026-08-21T15:12:03.000Z' });
    const first = await service.bootstrap({ participant:'repository-implementation' });
    const replay = await service.bootstrap({ participant:'repository-implementation' });
    assert(first.cycle_id === '2026-08-21T15:00Z', 'cycle identity was not derived from participant schedule');
    assert(first.run_id === 'scheduled:2026-08-21T15:00Z:repository-implementation', 'run identity was not deterministic');
    assert(first.scope.team === 'Ljh-projects' && first.scope.lanes.join(',') === 'lane:repo-implementation', 'bounded lane scope was not derived');
    assert(first.automation_id === '6a74051febd08191a86e737908a3e322', 'automation identity was not bound by runtime configuration');
    assert(replay.run_id === first.run_id && replay.run.idempotent_replay === true, 'bootstrap retry did not recover the same run');
    assert(!Object.prototype.hasOwnProperty.call(runs.requests[0], 'budget_seconds'), 'bootstrap duplicated standard budget constants instead of using run defaults');
  }));

  results.push(await run('dispatcher bootstrap receives team scope without executable worker lane', async () => {
    const service = createScheduledExecutionContextService({ runs:new FakeRuns(), now:()=>'2026-08-21T15:00:02.000Z' });
    const result = await service.bootstrap({ participant:'portfolio-dispatcher' });
    assert(result.lane === null && result.scope.lanes.length === 0, 'dispatcher was granted an execution lane');
    assert(result.run.worker === 'Portfolio Dispatcher' && result.run.continuation_key === 'scheduled:portfolio-dispatcher', 'dispatcher runtime identity was not derived');
  }));

  results.push(await run('scheduled bootstrap refuses caller-owned lifecycle identifiers and budgets', async () => {
    const service = createScheduledExecutionContextService({ runs:new FakeRuns(), now:()=>'2026-08-21T15:12:03.000Z' });
    let error = null;
    try { await service.bootstrap({ participant:'repository-implementation', run_id:'caller-run', budget_seconds:1 }); } catch (caught) { error = caught; }
    assert(error?.code === 'REQUEST_INVALID', 'caller-supplied lifecycle bookkeeping was accepted');
  }));

  results.push(await run('scheduled bootstrap rejects unknown participant', async () => {
    const service = createScheduledExecutionContextService({ runs:new FakeRuns(), now:()=>'2026-08-21T15:12:03.000Z' });
    let error = null;
    try { await service.bootstrap({ participant:'imaginary-worker' }); } catch (caught) { error = caught; }
    assert(error?.code === 'REQUEST_INVALID', 'unknown participant was accepted');
  }));

  const failed = results.filter((result)=>!result.ok);
  return { ok:failed.length === 0, passed:results.length - failed.length, failed:failed.length, tests:results };
}
