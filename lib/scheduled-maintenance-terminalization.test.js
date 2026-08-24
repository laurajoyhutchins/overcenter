import { createScheduledExecutionContextService } from 'lib/scheduled-execution-context.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok:true }; } catch (error) { return { name, ok:false, error:String(error?.message || error) }; } }

class FakeRuns {
  constructor() { this.rows = new Map(); this.finishRequests = []; }
  async start(input) {
    const existing = this.rows.get(input.run_id);
    if (existing) return { ...existing, idempotent_replay:true };
    const row = { ...input, status:'active', idempotent_replay:false };
    this.rows.set(input.run_id, row);
    return row;
  }
  async finish(input) {
    this.finishRequests.push(JSON.parse(JSON.stringify(input)));
    const row = this.rows.get(input.run_id);
    if (!row) throw new Error('run not found');
    const finished = { ...row, status:'finished', disposition:input.disposition, run_receipt:{ schema:'orchestration-run-receipt-v1', evidence_status:'complete', receipt_sha256:'m'.repeat(64) } };
    this.rows.set(input.run_id, finished);
    return finished;
  }
}

export async function runScheduledMaintenanceTerminalizationTests() {
  const results = [];
  results.push(await run('dispatcher maintenance failure terminalizes the runtime-owned run before surfacing the failure', async () => {
    const runs = new FakeRuns();
    const maintenance = async () => ({ status:502, body:{ ok:false, error:'LINEAR_UPSTREAM_GRAPHQL', may_have_mutated:false } });
    const service = createScheduledExecutionContextService({ runs, maintenance, now:()=>'2026-08-23T20:00:14.000Z' });
    let error = null;
    try { await service.bootstrap({ participant:'portfolio-dispatcher' }); } catch (caught) { error = caught; }
    assert(error?.code === 'RUNTIME_MAINTENANCE_FAILED', 'maintenance failure did not surface through the scheduled runtime boundary');
    assert(runs.finishRequests.length === 1, 'maintenance failure stranded the already-started scheduled run');
    assert(runs.finishRequests[0].disposition === 'failed', 'maintenance failure did not terminalize as failed');
    assert(runs.finishRequests[0].last_work_ref === null, 'maintenance failure invented work ownership');
    assert(runs.finishRequests[0].last_gate === 'lane:enable', 'maintenance failure lost the dispatcher gate');
    assert(String(runs.finishRequests[0].stop_reason || '').includes('orchestration.maintain'), 'maintenance failure did not preserve the failing boundary in terminal evidence');
  }));
  return results;
}
