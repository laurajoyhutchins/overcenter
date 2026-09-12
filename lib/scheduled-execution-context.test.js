import test from 'node:test';
import { createScheduledExecutionContextService } from 'lib/scheduled-execution-context.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
// Native node:test owns execution and failure aggregation.

class FakeRuns {
  constructor() { this.requests = []; this.finishRequests = []; this.rows = new Map(); }
  async start(input) {
    this.requests.push(JSON.parse(JSON.stringify(input)));
    const existing = this.rows.get(input.run_id);
    if (existing) return { ...existing, idempotent_replay:true };
    const row = { ...JSON.parse(JSON.stringify(input)), status:'active', started_at:'2026-08-21T15:12:03.000Z', idempotent_replay:false };
    this.rows.set(input.run_id, row);
    return row;
  }
  async finish(input) {
    this.finishRequests.push(JSON.parse(JSON.stringify(input)));
    const row = this.rows.get(input.run_id);
    if (!row) throw new Error('run not found');
    const finished = { ...row, status:'finished', disposition:input.disposition, last_work_ref:input.last_work_ref || null, last_gate:input.last_gate || null, run_receipt:{ schema:'orchestration-run-receipt-v1', evidence_status:'complete', receipt_sha256:'r'.repeat(64) } };
    this.rows.set(input.run_id, finished);
    return finished;
  }
}

class FakeRuntimeStore {
  constructor() { this.leases = new Map(); }
  async activeLeaseForRun(runId) { return this.leases.get(runId) || null; }
}

function fakeTransport(calls) {
  return async (command, input) => {
    calls.push({ command, input:JSON.parse(JSON.stringify(input)) });
    if (command === 'work.claim') return { status:200, body:{ ok:true, work_ref:input.work_ref, lease_ref:'lease-1', lane:'lane:repo-implementation' } };
    if (command === 'work.heartbeat') return { status:200, body:{ ok:true, work_ref:'LJH-382', lease_ref:input.lease_ref, checkpoint_sha256:'c'.repeat(64), expires_at:'2026-08-21T15:55:00.000Z' } };
    if (command === 'skill.activate') return { status:200, body:{ ok:true, activation_id:'00000000-0000-4000-8000-000000000001', run_id:input.run_id, skill:input.skill, status:'active' } };
    if (command === 'skill.complete') return { status:200, body:{ ok:true, activation_id:input.activation_id, run_id:input.run_id, skill:'verification-before-completion', status:'completed' } };
    if (command === 'work.settle') return { status:200, body:{ ok:true, work_ref:'LJH-382', lease_ref:input.lease_ref, disposition:input.disposition, current_lane:'lane:verification' } };
    throw new Error(`unexpected command ${command}`);
  };
}

function fakeReconcile(calls, summary = { created:1, reused:0, updated:0, ignored:0, rejected:0 }) {
  return async (input) => {
    calls.push(JSON.parse(JSON.stringify(input)));
    return { status:200, body:{ ok:true, project:input.project, summary, items:[], command:'portfolio.reconcile_work_surface' } };
  };
}

function fakeMaintenance(calls, actionCount = 0) {
  return async (input) => {
    calls.push(JSON.parse(JSON.stringify(input)));
    return { status:200, body:{ ok:true, actions:Array.from({length:actionCount}, (_,index)=>({kind:`repair-${index + 1}`})), action_count:actionCount, semantic_work_mutations:0, command:'orchestration.maintain' } };
  };
}

// Legacy exported suite wrapper removed.

  test('scheduled bootstrap derives run cycle scope and retry identity from participant only', async () => {
    const runs = new FakeRuns();
    const service = createScheduledExecutionContextService({ runs, now:()=>'2026-08-21T15:24:03.000Z' });
    const first = await service.bootstrap({ participant:'repository-implementation' });
    const replay = await service.bootstrap({ participant:'repository-implementation' });
    assert(first.cycle_id === '2026-08-21T15:00Z', 'cycle identity was not derived from participant schedule');
    assert(first.run_id === 'scheduled:2026-08-21T15:00Z:repository-implementation', 'run identity was not deterministic');
    assert(first.scope.team === 'Ljh-projects' && first.scope.lanes.join(',') === 'lane:repo-implementation', 'bounded lane scope was not derived');
    assert(first.automation_id === '6a74051febd08191a86e737908a3e322', 'automation identity was not bound by runtime configuration');
    assert(first.stage === 'EXECUTE' && first.command === 'work.execute', 'scheduled session was not bound to the Execute command');
    assert(replay.run_id === first.run_id && replay.run.idempotent_replay === true, 'bootstrap retry did not recover the same run');
    assert(!Object.prototype.hasOwnProperty.call(runs.requests[0], 'budget_seconds'), 'bootstrap duplicated standard budget constants instead of using run defaults');
  });

  test('Enable bootstrap receives the generated enable projection lane', async () => {
    const service = createScheduledExecutionContextService({ runs:new FakeRuns(), maintenance:fakeMaintenance([]), now:()=>'2026-08-21T15:00:02.000Z' });
    const result = await service.bootstrap({ participant:'portfolio-dispatcher' });
    assert(result.lane === 'lane:enable' && result.scope.lanes.join(',') === 'lane:enable', 'Enable executor was not bound to its projection lane');
    assert(result.run.worker === 'Enable' && result.run.continuation_key === 'scheduled:portfolio-dispatcher', 'scheduler identity was not derived');
    assert(result.stage === 'ENABLE' && result.command === 'work.enable', 'Enable command metadata was not derived');
  });

  test('dispatcher bootstrap performs deterministic maintenance with hidden run correlation', async () => {
    const maintenanceCalls = [];
    const service = createScheduledExecutionContextService({ runs:new FakeRuns(), maintenance:fakeMaintenance(maintenanceCalls), now:()=>'2026-08-21T15:00:02.000Z' });
    await service.bootstrap({ participant:'portfolio-dispatcher' });
    assert(maintenanceCalls.length === 1, 'dispatcher bootstrap did not perform deterministic maintenance exactly once');
    assert(maintenanceCalls[0].run_id === 'scheduled:2026-08-21T15:00Z:portfolio-dispatcher', 'dispatcher maintenance was not correlated to runtime-owned run identity');
  });

  test('scheduled bootstrap refuses caller-owned lifecycle identifiers and budgets', async () => {
    const service = createScheduledExecutionContextService({ runs:new FakeRuns(), now:()=>'2026-08-21T15:12:03.000Z' });
    let error = null;
    try { await service.bootstrap({ participant:'repository-implementation', run_id:'caller-run', budget_seconds:1 }); } catch (caught) { error = caught; }
    assert(error?.code === 'REQUEST_INVALID', 'caller-supplied lifecycle bookkeeping was accepted');
  });

  test('scheduled bootstrap rejects unknown participant', async () => {
    const service = createScheduledExecutionContextService({ runs:new FakeRuns(), now:()=>'2026-08-21T15:12:03.000Z' });
    let error = null;
    try { await service.bootstrap({ participant:'imaginary-worker' }); } catch (caught) { error = caught; }
    assert(error?.code === 'REQUEST_INVALID', 'unknown participant was accepted');
  });

  test('scheduled claim owns run correlation and does not expose lease identity to worker', async () => {
    const runs = new FakeRuns();
    const runtimeStore = new FakeRuntimeStore();
    const calls = [];
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport:fakeTransport(calls), now:()=>'2026-08-21T15:12:03.000Z' });
    const result = await service.execute({ participant:'repository-implementation', operation:'claim', input:{ work_ref:'LJH-382', observed_revision:'revision-1' } });
    assert(calls.length === 1 && calls[0].command === 'work.claim', 'claim was not routed through semantic worker transport');
    assert(calls[0].input.run_id === 'scheduled:2026-08-21T15:00Z:repository-implementation', 'runtime did not own claim correlation');
    assert(!Object.prototype.hasOwnProperty.call(result.result, 'lease_ref'), 'lease identity leaked into worker-facing result');
  });

  test('scheduled progress turns semantic checkpoint into runtime-owned lease renewal', async () => {
    const runs = new FakeRuns();
    const runtimeStore = new FakeRuntimeStore();
    const calls = [];
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport:fakeTransport(calls), now:()=>'2026-08-21T15:12:03.000Z' });
    const context = await service.bootstrap({ participant:'repository-implementation' });
    runtimeStore.leases.set(context.run_id, { lease_ref:'lease-1', work_ref:'LJH-382', gate:'lane:repo-implementation', status:'active' });
    const result = await service.execute({ participant:'repository-implementation', operation:'progress', input:{ phase:'implementation', next_action:'run-tests', evidence:[{kind:'commit',ref:'abc'}] } });
    assert(calls.length === 1 && calls[0].command === 'work.heartbeat', 'progress did not perform runtime-owned heartbeat');
    assert(calls[0].input.lease_ref === 'lease-1' && calls[0].input.phase === 'implementation', 'runtime did not bind active lease to semantic progress');
    assert(result.result.checkpoint_sha256 === 'c'.repeat(64) && !Object.prototype.hasOwnProperty.call(result.result, 'lease_ref'), 'progress result lost checkpoint evidence or leaked lease identity');
  });

  test('scheduled skill lifecycle is bound to the runtime-owned run and remains nonterminal', async () => {
    const runs = new FakeRuns();
    const runtimeStore = new FakeRuntimeStore();
    const calls = [];
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport:fakeTransport(calls), now:()=>'2026-08-21T15:12:03.000Z' });
    const activated = await service.execute({ participant:'repository-implementation', operation:'skill_activate', input:{ skill:'verification-before-completion', reason:'candidate ready for verification' } });
    assert(calls[0]?.command === 'skill.activate', 'scheduled skill activation did not use semantic worker transport');
    assert(calls[0]?.input?.run_id === 'scheduled:2026-08-21T15:00Z:repository-implementation', 'scheduled activation was not bound to runtime-owned run identity');
    assert(activated.terminal === false && activated.result?.activation_id, 'scheduled activation unexpectedly terminalized the run');
    const completed = await service.execute({ participant:'repository-implementation', operation:'skill_complete', input:{ activation_id:activated.result.activation_id, outcome:'completed', evidence:[{kind:'test_run',ref:'green'}] } });
    assert(calls[1]?.command === 'skill.complete' && calls[1]?.input?.run_id === calls[0]?.input?.run_id, 'scheduled skill completion lost runtime-owned run correlation');
    assert(completed.terminal === false && completed.result?.status === 'completed', 'scheduled skill completion unexpectedly terminalized the run');
  });

  test('scheduled settlement consumes active lease then terminalizes the run automatically', async () => {
    const runs = new FakeRuns();
    const runtimeStore = new FakeRuntimeStore();
    const calls = [];
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport:fakeTransport(calls), now:()=>'2026-08-21T15:12:03.000Z' });
    const context = await service.bootstrap({ participant:'repository-implementation' });
    runtimeStore.leases.set(context.run_id, { lease_ref:'lease-1', work_ref:'LJH-382', gate:'lane:repo-implementation', status:'active' });
    const result = await service.execute({ participant:'repository-implementation', operation:'settle', input:{ disposition:'completed', evidence:[{kind:'test',ref:'394/394'}] } });
    assert(calls.length === 1 && calls[0].command === 'work.settle', 'settlement was not routed through semantic worker transport');
    assert(runs.finishRequests.length === 1 && runs.finishRequests[0].disposition === 'completed', 'terminal settlement did not automatically finish run');
    assert(result.terminal === true && result.run_receipt?.evidence_status === 'complete', 'automatic terminalization did not return run receipt');
  });

  test('scheduled idle terminalizes no-work without lifecycle acknowledgement', async () => {
    const runs = new FakeRuns();
    const runtimeStore = new FakeRuntimeStore();
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport:fakeTransport([]), now:()=>'2026-08-21T15:12:03.000Z' });
    const result = await service.execute({ participant:'repository-implementation', operation:'idle', input:{} });
    assert(runs.finishRequests.length === 1 && runs.finishRequests[0].disposition === 'no-work', 'idle did not terminalize run as no-work');
    assert(result.terminal === true && result.run_receipt?.receipt_sha256 === 'r'.repeat(64), 'idle did not return durable terminal receipt');
  });

  test('dispatcher idle remains truthful when automatic maintenance produced a durable repair', async () => {
    const runs = new FakeRuns();
    const service = createScheduledExecutionContextService({ runs, runtimeStore:new FakeRuntimeStore(), transport:fakeTransport([]), maintenance:fakeMaintenance([], 1), now:()=>'2026-08-21T15:00:03.000Z' });
    const result = await service.execute({ participant:'portfolio-dispatcher', operation:'idle', input:{} });
    assert(runs.finishRequests.length === 1 && runs.finishRequests[0].disposition === 'completed', 'dispatcher maintenance effect was mislabeled as no-work');
    assert(result.result?.maintenance_action_count === 1, 'dispatcher idle receipt did not expose bounded maintenance effect count');
  });

  test('dispatcher reconcile owns run correlation and terminalizes a durable non-lease effect', async () => {
    const runs = new FakeRuns();
    const runtimeStore = new FakeRuntimeStore();
    const reconcileCalls = [];
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport:fakeTransport([]), reconcile:fakeReconcile(reconcileCalls), maintenance:fakeMaintenance([]), now:()=>'2026-08-21T15:00:03.000Z' });
    const result = await service.execute({ participant:'portfolio-dispatcher', operation:'reconcile', input:{ project:'Overcenter Reliability', items:[{ source:{kind:'github_issue',repo:'owner/repo',issue_number:7}, projection:{title:'x'} }] } });
    assert(reconcileCalls.length === 1, 'dispatcher reconciliation was not executed exactly once');
    assert(reconcileCalls[0].run_id === 'scheduled:2026-08-21T15:00Z:portfolio-dispatcher', 'runtime did not inject hidden run correlation into reconciliation');
    assert(runs.finishRequests.length === 1 && runs.finishRequests[0].disposition === 'completed', 'durable dispatcher effect did not terminalize run as completed');
    assert(result.terminal === true && result.run_receipt?.evidence_status === 'complete', 'dispatcher reconciliation did not return a durable run receipt');
  });

  test('non-dispatcher cannot use dispatcher reconciliation semantic', async () => {
    const service = createScheduledExecutionContextService({ runs:new FakeRuns(), runtimeStore:new FakeRuntimeStore(), transport:fakeTransport([]), reconcile:fakeReconcile([]), now:()=>'2026-08-21T15:12:03.000Z' });
    let error = null;
    try { await service.execute({ participant:'repository-implementation', operation:'reconcile', input:{ project:'x', items:[] } }); } catch (caught) { error = caught; }
    assert(error?.code === 'REQUEST_INVALID', 'dispatcher-only reconcile semantic was exposed to an implementation lane');
  });

  // No legacy suite result collector remains.
