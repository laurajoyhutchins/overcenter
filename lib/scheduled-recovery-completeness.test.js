import { createScheduledExecutionContextService } from 'lib/scheduled-execution-context.js';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

class FakeRuns {
  constructor() { this.finishRequests = []; }
  async start(input) { return { ...input, status:'active', idempotent_replay:false }; }
  async finish(input) {
    this.finishRequests.push(JSON.parse(JSON.stringify(input)));
    return {
      ...input,
      status:'finished',
      run_receipt:{ schema:'orchestration-run-receipt-v1', evidence_status:'complete', receipt_sha256:'r'.repeat(64) },
    };
  }
}

export async function runScheduledRecoveryCompletenessTests() {
  const failures = [];
  let passed = 0;
  async function test(name, fn) {
    try { await fn(); passed += 1; }
    catch (error) { failures.push({ name, error:String(error?.message || error) }); }
  }

  await test('claim recovery is scoped to the requested work item', async () => {
    const runs = new FakeRuns();
    const recoveryLookups = [];
    const unrelatedLease = { lease_ref:'lease-other', work_ref:'LJH-999', gate:'lane:repo-implementation', status:'active', expires_at:'2026-08-24T15:00:00.000Z' };
    const runtimeStore = {
      async activeLeaseForRun() { return unrelatedLease; },
      async claimRecoveryStateForRun(_runId, workRef) {
        recoveryLookups.push(workRef);
        if (workRef === 'LJH-382') return null;
        return { ...unrelatedLease, status:'claiming' };
      },
      async leaseStateByRef() { return null; },
    };
    const calls = [];
    const transport = async (command, input) => {
      calls.push({ command, input:JSON.parse(JSON.stringify(input)) });
      return { status:502, body:{ ok:false, error:'INTERNAL_ERROR', error_class:'internal', retryable:false, may_have_mutated:true, recommended_action:'reconcile_external_effect' } };
    };
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport, now:()=>'2026-08-24T14:12:03.000Z' });
    const result = await service.execute({ participant:'repository-implementation', operation:'claim', input:{ work_ref:'LJH-382', observed_revision:'revision-1' } });
    check(calls.length === 1, `unrelated claiming state caused ${calls.length} claim attempts`);
    check(recoveryLookups[0] === 'LJH-382', `claim recovery lookup used ${String(recoveryLookups[0])} instead of requested work_ref`);
    check(runs.finishRequests.length === 0, 'unrelated live ownership was ignored during claim failure recovery');
    check(result.ok === false && result.terminal === false, 'unrelated active lease should preserve the run without replaying the failed claim');
  });

  await test('claim terminalization loses safely when a concurrent claim acquires ownership first', async () => {
    const runs = new FakeRuns();
    runs.finish = async (input) => {
      runs.finishRequests.push(JSON.parse(JSON.stringify(input)));
      const error = new Error('orchestration run cannot finish while it owns an active lease');
      error.code = 'RUN_HAS_ACTIVE_LEASE';
      throw error;
    };
    let activeChecks = 0;
    const runtimeStore = {
      async activeLeaseForRun() {
        activeChecks += 1;
        return null;
      },
      async claimRecoveryStateForRun() { return null; },
      async leaseStateByRef() { return null; },
    };
    const transport = async () => ({ status:502, body:{ ok:false, error:'INTERNAL_ERROR', error_class:'internal', retryable:false, may_have_mutated:true, recommended_action:'reconcile_external_effect' } });
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport, now:()=>'2026-08-24T14:12:03.000Z' });
    const result = await service.execute({ participant:'repository-implementation', operation:'claim', input:{ work_ref:'LJH-382', observed_revision:'revision-1' } });
    check(activeChecks >= 1, 'claim failure never checked runtime ownership before terminalization');
    check(runs.finishRequests.length === 1, 'claim failure never attempted terminalization');
    check(result.ok === false && result.terminal === false, 'terminalization fence conflict must preserve the run for the winning claim');
  });

  await test('lost settlement response recovers a durable settled receipt and terminalizes', async () => {
    const runs = new FakeRuns();
    const lease = { lease_ref:'lease-1', work_ref:'LJH-382', gate:'lane:repo-implementation', status:'active', expires_at:'2026-08-24T15:00:00.000Z', settle_receipt:null };
    const runtimeStore = {
      async activeLeaseForRun() { return lease.status === 'settled' ? null : lease; },
      async claimRecoveryStateForRun() { return null; },
      async leaseStateByRef() { return { ...lease }; },
    };
    const transport = async () => {
      lease.status = 'settled';
      lease.settle_receipt = {
        ok:true,
        work_ref:'LJH-382',
        lease_id:'lease-1',
        disposition:'completed',
        previous_state:'Todo',
        current_state:'Todo',
        previous_lane:'lane:repo-implementation',
        current_lane:'lane:verification',
        settled_at:'2026-08-24T14:12:04.000Z',
        idempotent_replay:true,
      };
      return { status:502, body:{ ok:false, error:'LINEAR_UPSTREAM_HTTP', error_class:'upstream', retryable:false, may_have_mutated:true, recommended_action:'reconcile_external_effect' } };
    };
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport, now:()=>'2026-08-24T14:12:03.000Z' });
    const result = await service.execute({ participant:'repository-implementation', operation:'settle', input:{ disposition:'completed', evidence:[] } });
    check(result.ok === true && result.terminal === true, 'durably settled lease did not recover as terminal success');
    check(runs.finishRequests.length === 1, 'recovered settlement did not terminalize the orchestration run');
  });

  await test('settling lease replays the identical settlement request once', async () => {
    const runs = new FakeRuns();
    const lease = { lease_ref:'lease-2', work_ref:'LJH-383', gate:'lane:repo-implementation', status:'settling', expires_at:'2026-08-24T15:00:00.000Z', settle_receipt:null };
    const runtimeStore = {
      async activeLeaseForRun() { return lease.status === 'settled' ? null : lease; },
      async claimRecoveryStateForRun() { return null; },
      async leaseStateByRef() { return { ...lease }; },
    };
    const calls = [];
    const transport = async (command, input) => {
      calls.push({ command, input:JSON.parse(JSON.stringify(input)) });
      if (calls.length === 1) return { status:502, body:{ ok:false, error:'LINEAR_TRANSITION_FAILED', error_class:'upstream', retryable:false, may_have_mutated:true, recommended_action:'reconcile_external_effect' } };
      lease.status = 'settled';
      return { status:200, body:{ ok:true, work_ref:'LJH-383', lease_id:'lease-2', disposition:'completed', previous_lane:'lane:repo-implementation', current_lane:'lane:verification', settled_at:'2026-08-24T14:12:05.000Z', idempotent_replay:true } };
    };
    const service = createScheduledExecutionContextService({ runs, runtimeStore, transport, now:()=>'2026-08-24T14:12:03.000Z' });
    const result = await service.execute({ participant:'repository-implementation', operation:'settle', input:{ disposition:'completed', evidence:[] } });
    check(calls.length === 2, `settling recovery attempted settlement ${calls.length} time(s)`);
    check(JSON.stringify(calls[0].input) === JSON.stringify(calls[1].input), 'settling recovery changed the semantic settlement request');
    check(result.ok === true && result.terminal === true, 'settling replay did not converge to terminal success');
  });

  return { ok: failures.length === 0, passed, failed:failures.length, failures };
}
