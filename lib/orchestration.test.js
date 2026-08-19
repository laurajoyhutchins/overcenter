import {
  executeCorrelatedCommand,
  journalOutcomeFor,
  safeRequestProjection,
  safeResultProjection,
  semanticRequestHash,
} from 'lib/orchestration-journal.js';
import { createOrchestrationResumeService } from 'lib/orchestration-recovery.js';
import { projectOrchestrationStatus } from 'lib/orchestration-status.js';
import * as orchestrationRuns from 'lib/orchestration-runs.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }

class FakeJournal {
  constructor() { this.starts = []; this.finishes = []; }
  async start(row) {
    this.starts.push(JSON.parse(JSON.stringify(row)));
    return { invocation_id: `inv-${this.starts.length}`, sequence: this.starts.length, started_at: '2026-08-17T20:00:00.000Z' };
  }
  async finish(id, body) {
    const outcome = body.ok ? 'succeeded' : (String(body.error || '').includes('INDETERMINATE') ? 'indeterminate' : (body.rejection ? 'rejected' : 'failed'));
    this.finishes.push({ id, body: JSON.parse(JSON.stringify(body)), outcome });
    return { outcome };
  }
}

function issue(state = 'In Progress', lane = 'lane:repo-implementation') {
  return {
    identifier: 'LJH-1', updatedAt: '2026-08-17T20:00:00.000Z',
    state: { name: state }, labels: [{ id: 'lane-1', name: lane }],
  };
}

function resumeHarness(lease, { last = null, unresolved = null, slot = null, linearIssue = issue(), portfolioReceipt = null, checkpoint = null } = {}) {
  const store = {
    async lastInvocation() { return last; },
    async unresolvedInvocation() { return unresolved; },
    async latestLease() { return lease; },
    async latestCheckpoint() { return checkpoint; },
    async slot() { return slot; },
    async portfolioReceipt() { return portfolioReceipt; },
  };
  const authoritative = { async getIssue() { return linearIssue; } };
  return createOrchestrationResumeService({ store, authoritative, now: () => '2026-08-17T20:30:00.000Z' });
}

function activeLease(overrides = {}) {
  return {
    lease_id: 'lease-1', work_ref: 'LJH-1', gate: 'lane:repo-implementation', run_id: 'run-1',
    lease_token: 'wlt_SECRET_TOKEN', status: 'active', created_at: '2026-08-17T20:00:00.000Z',
    expires_at: '2026-08-17T21:00:00.000Z', claim_idempotency_key: 'claim-1',
    ...overrides,
  };
}

export async function runOrchestrationTests() {
  const results = [];

  results.push(await run('run_id metadata does not alter semantic hash for newly correlated commands', async () => {
    const a = await semanticRequestHash('github.delete_branch', { repo: 'owner/repo', branch: 'x', expected_head: 'a'.repeat(40), run_id: 'run-a' });
    const b = await semanticRequestHash('github.delete_branch', { repo: 'owner/repo', branch: 'x', expected_head: 'a'.repeat(40), run_id: 'run-b' });
    assert(a === b, 'run_id polluted semantic request hash');
    const claimA = await semanticRequestHash('work.claim', { work_ref: 'LJH-1', run_id: 'run-a', idempotency_key: 'k' });
    const claimB = await semanticRequestHash('work.claim', { work_ref: 'LJH-1', run_id: 'run-b', idempotency_key: 'k' });
    assert(claimA !== claimB, 'existing work.claim run_id contract was silently changed');
  }));

  results.push(await run('correlated success records bounded projection and propagates run_id', async () => {
    const journal = new FakeJournal();
    const response = await executeCorrelatedCommand('github.delete_branch', {
      repo: 'owner/repo', branch: 'feature/x', expected_head: 'a'.repeat(40), run_id: 'run-1',
    }, async () => ({ ok: true, repo: 'owner/repo', branch: 'feature/x', outcome: 'deleted' }), { journal });
    assert(response.body.ok === true && response.body.run_id === 'run-1', 'run_id not propagated');
    assert(journal.starts.length === 1 && journal.finishes.length === 1, 'journal invocation not correlated');
  }));

  results.push(await run('expected rejection and indeterminate mutation are distinct journal outcomes', async () => {
    const rejectedJournal = new FakeJournal();
    await executeCorrelatedCommand('github.delete_branch', {
      repo: 'owner/repo', branch: 'feature/x', expected_head: 'a'.repeat(40), run_id: 'run-r',
    }, async () => ({ ok: false, error: 'HEAD_MISMATCH', message: 'stale' }), { journal: rejectedJournal });
    assert(rejectedJournal.finishes[0].body.rejection === true, 'expected rejection lost rejection classification');
    assert(journalOutcomeFor(rejectedJournal.finishes[0].body) === 'rejected', 'expected rejection was not journaled as rejected');
    const indeterminateJournal = new FakeJournal();
    await executeCorrelatedCommand('github.delete_branch', {
      repo: 'owner/repo', branch: 'feature/x', expected_head: 'a'.repeat(40), run_id: 'run-i',
    }, async () => ({ ok: false, error: 'BRANCH_DELETE_INDETERMINATE', message: 'lost', may_have_mutated: true }), { journal: indeterminateJournal, flattenDetails: true });
    assert(indeterminateJournal.finishes[0].body.retryable === true && indeterminateJournal.finishes[0].body.may_have_mutated === true, 'indeterminate mutation not preserved');
    assert(journalOutcomeFor(indeterminateJournal.finishes[0].body) === 'indeterminate', 'ambiguous mutation was not journaled as indeterminate');
  }));

  results.push(await run('journal projections exclude lease tokens and full source content', async () => {
    const request = safeRequestProjection('github.apply_changeset', {
      repo: 'owner/repo', branch: 'x', changes: [{ path: 'a.txt', content: 'SUPER_SECRET_SOURCE', operation: 'update' }],
      commit_message: 'bounded', idempotency_key: 'k',
    });
    const result = safeResultProjection('work.claim', { work_ref: 'LJH-1', lease_id: 'lease-1', lease_token: 'wlt_SECRET', current_state: 'In Progress' });
    const serialized = JSON.stringify({ request, result });
    assert(!serialized.includes('SUPER_SECRET_SOURCE'), 'source content leaked into journal projection');
    assert(!serialized.includes('wlt_SECRET'), 'lease token leaked into journal projection');
    assert(request.changed_paths[0] === 'a.txt', 'bounded changed-path evidence missing');
  }));

  results.push(await run('resume packet does not self-shadow the run it is reconstructing', async () => {
    const journal = new FakeJournal();
    const response = await executeCorrelatedCommand('orchestration.resume_packet', { run_id: 'prior-run' }, async (input) => ({ ok: true, run_id: input.run_id, continuation: 'recompute_frontier' }), { journal });
    assert(response.body.ok === true && response.body.run_id === 'prior-run', 'resume target run_id missing from envelope');
    assert(journal.starts.length === 0 && journal.finishes.length === 0, 'resume call wrote into the target run before reconstruction');
  }));

  results.push(await run('active lease after session loss returns recover_active_lease with its token', async () => {
    const lease = activeLease();
    const service = resumeHarness(lease, { slot: { lease_id: lease.lease_id, expires_at: lease.expires_at } });
    const packet = await service.resume({ run_id: 'run-1' });
    assert(packet.continuation === 'recover_active_lease', `unexpected continuation ${packet.continuation}`);
    assert(packet.active_execution.lease_token === 'wlt_SECRET_TOKEN', 'owned active lease token missing from recovery packet');
    assert(packet.historical_correlation_missing === true, 'pre-journal lease did not report missing correlation history');
  }));

  results.push(await run('active lease recovery exposes latest checkpoint identity without expanding project authority', async () => {
    const lease = activeLease();
    const checkpoint = { checkpoint_sha256: 'c'.repeat(64), created_at: '2026-08-17T20:20:00.000Z', checkpoint: { schema: 'work-checkpoint-v1', phase: 'diagnostic_complete', next_action_kind: 'apply_repository_change' } };
    const service = resumeHarness(lease, { slot: { lease_id: lease.lease_id, expires_at: lease.expires_at }, checkpoint });
    const packet = await service.resume({ run_id: 'run-1' });
    assert(packet.active_execution.checkpoint?.checkpoint_sha256 === 'c'.repeat(64), 'checkpoint digest missing from active recovery');
    assert(packet.active_execution.checkpoint?.phase === 'diagnostic_complete', 'checkpoint phase missing from active recovery');
    assert(packet.active_execution.checkpoint?.next_action_kind === 'apply_repository_change', 'checkpoint next action missing from active recovery');
  }));

  results.push(await run('settling lease returns exact semantic settlement replay material', async () => {
    const lease = activeLease({
      status: 'settling', settle_idempotency_key: 'settle-1', settle_request_hash: 'hash-1',
      settle_plan: { state: 'Todo', lane: 'lane:verification', replay_request: { disposition: 'completed', evidence: [{ kind: 'pr', ref: '1' }], reason: null, promotion_condition: null, next_state: null, next_lane: null } },
    });
    const service = resumeHarness(lease, { slot: { lease_id: lease.lease_id, expires_at: lease.expires_at } });
    const packet = await service.resume({ run_id: 'run-1' });
    assert(packet.continuation === 'retry_same_request', 'settling lease was not replayable');
    assert(packet.retry.command === 'work.settle' && packet.retry.request.idempotency_key === 'settle-1', 'settlement replay identity missing');
    assert(packet.retry.request.lease_token === 'wlt_SECRET_TOKEN', 'settlement replay token missing');
  }));

  results.push(await run('settled lease is terminal or quiescent', async () => {
    const service = resumeHarness(activeLease({ status: 'settled' }));
    const packet = await service.resume({ run_id: 'run-1' });
    assert(packet.continuation === 'terminal_or_quiescent', 'settled lease did not produce terminal continuation');
    assert(packet.active_execution === null, 'settled lease exposed active execution');
  }));

  results.push(await run('expired active lease does not expose stale ownership token', async () => {
    const lease = activeLease({ expires_at: '2026-08-17T20:10:00.000Z' });
    const service = resumeHarness(lease, { slot: { lease_id: lease.lease_id, expires_at: lease.expires_at } });
    const packet = await service.resume({ run_id: 'run-1' });
    assert(packet.continuation === 'recompute_frontier', 'expired lease did not require frontier recomputation');
    assert(!packet.active_execution.lease_token, 'expired lease exposed token as active ownership');
  }));

  results.push(await run('materially invalidated lease requires owner action', async () => {
    const service = resumeHarness(activeLease({ status: 'invalidated', reconciliation: { changed_fields: ['gate'] } }));
    const packet = await service.resume({ run_id: 'run-1' });
    assert(packet.continuation === 'owner_action_required', 'invalidated lease was silently resumed');
    assert(packet.evidence[0].kind === 'invalidated_lease', 'invalidation evidence missing');
  }));

  results.push(await run('status projection detects each seeded stranded condition and stays bounded', async () => {
    const stamp = '2026-08-17T19:00:00.000Z';
    const status = projectOrchestrationStatus({
      expired_active_slots: [{ work_ref: 'LJH-1', gate: 'lane:x', lease_id: 'l1', expires_at: stamp, observed_at: stamp }],
      leases_stuck_claiming: [{ work_ref: 'LJH-2', lease_id: 'l2', run_id: 'r2', updated_at: stamp, observed_at: stamp }],
      leases_stuck_settling: [{ work_ref: 'LJH-3', lease_id: 'l3', run_id: 'r3', updated_at: stamp, observed_at: stamp }],
      journal_stuck_running: [{ invocation_id: 'i1', run_id: 'r4', command: 'x', started_at: stamp, observed_at: stamp }],
      journal_indeterminate: [{ invocation_id: 'i2', run_id: 'r5', command: 'y', started_at: stamp, observed_at: stamp, error_code: 'E' }],
      github_changesets_processing: [{ repo: 'o/r', idempotency_key: 'g1', branch: 'x', updated_at: stamp, observed_at: stamp }],
      github_changesets_prepared: [{ repo: 'o/r', idempotency_key: 'g2', branch: 'y', commit_sha: 'a'.repeat(40), updated_at: stamp, observed_at: stamp }],
      portfolio_reconcile_processing: [{ idempotency_key: 'p1', phase: 'x', updated_at: stamp, observed_at: stamp }],
      portfolio_reconcile_indeterminate: [{ idempotency_key: 'p2', phase: 'indeterminate', updated_at: stamp, observed_at: stamp }],
      recent_command_outcomes: [], recent_error_codes: [], recent_expected_rejections: [],
    });
    assert(status.healthy === false, 'seeded stranded state reported healthy');
    for (const value of Object.values(status.conditions)) assert(value.count === 1 && value.oldest_refs.length === 1, 'status condition not detected or bounded');
  }));

  results.push(await run('run start persists bounded budget and recovers latest compatible predecessor', async () => {
    assert(typeof orchestrationRuns.createOrchestrationRunService === 'function', 'createOrchestrationRunService is not implemented');
    const rows = new Map();
    const store = {
      async getRun(id) { return rows.get(id) || null; },
      async findPredecessor(key, scopeSha, exclude) { return [...rows.values()].filter(r => r.continuation_key === key && r.scope_sha256 === scopeSha && r.run_id !== exclude).sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at)))[0] || null; },
      async insertRun(row) { rows.set(row.run_id, { ...row }); return rows.get(row.run_id); },
      async latestHorizon() { return null; },
    };
    const service = orchestrationRuns.createOrchestrationRunService({ store, now: () => '2026-08-18T20:00:00.000Z' });
    const first = await service.start({ run_id: 'run-a', worker: 'Repository Implementation', mode: 'scheduled', continuation_key: 'scheduled:repo', scope: { project: 'Portfolio Orchestration', lanes: ['lane:repo-implementation'] } });
    assert(first.budget.deadline_at === '2026-08-18T20:45:00.000Z', 'scheduled run did not receive 45 minute budget');
    assert(first.budget.settlement_reserve_seconds === 300 && first.budget.minimum_new_gate_seconds === 600, 'budget reserves are wrong');
    const second = await service.start({ run_id: 'run-b', worker: 'Repository Implementation', mode: 'scheduled', continuation_key: 'scheduled:repo', scope: { project: 'Portfolio Orchestration', lanes: ['lane:repo-implementation'] } });
    assert(second.predecessor_run_id === 'run-a', 'compatible predecessor was not recovered');
  }));

  results.push(await run('advisory horizon revalidates semantic fingerprints and never grants ownership', async () => {
    assert(typeof orchestrationRuns.createOrchestrationRunService === 'function', 'createOrchestrationRunService is not implemented');
    const runRow = { run_id: 'run-h', continuation_key: 'scheduled:repo', scope_sha256: 'scope', status: 'active', deadline_at: '2026-08-18T21:00:00.000Z', settlement_reserve_seconds: 300, minimum_new_gate_seconds: 600 };
    let saved = null;
    let current = { identifier: 'LJH-1', project: { name: 'Portfolio Orchestration' }, archivedAt: null, state: { name: 'Todo', type: 'unstarted' }, labels: [{ id: 'l', name: 'lane:repo-implementation' }], priority: 2, description: 'Repository: owner/repo\n\nAcceptance: bounded', relations: [] };
    const store = {
      async getRun() { return runRow; },
      async nextHorizonGeneration() { return 1; },
      async insertHorizon(row) { saved = { ...row }; return saved; },
      async latestHorizon() { return saved; },
      async updateRunHorizon() {},
    };
    const authoritative = { async getIssue() { return JSON.parse(JSON.stringify(current)); } };
    const service = orchestrationRuns.createOrchestrationRunService({ store, authoritative, now: () => '2026-08-18T20:00:00.000Z' });
    const checkpoint = await service.checkpointHorizon({ run_id: 'run-h', candidates: [{ work_ref: 'LJH-1', expected_state: 'Todo', expected_lane: 'lane:repo-implementation', selection_reason: 'direct_successor' }] });
    assert(checkpoint.candidates[0].execution_fingerprint?.length === 64, 'horizon did not retain execution fingerprint');
    assert(checkpoint.ownership_granted === false, 'horizon accidentally granted ownership');
    const valid = await service.resolveHorizon({ run_id: 'run-h' });
    assert(valid.candidates[0].status === 'valid', 'unchanged horizon entry was not reusable');
    current.priority = 1;
    const stale = await service.resolveHorizon({ run_id: 'run-h' });
    assert(stale.candidates[0].status === 'materially_changed', 'changed authority did not invalidate horizon entry');
  }));

  results.push(await run('run finish persists machine continuation without changing work authority', async () => {
    assert(typeof orchestrationRuns.createOrchestrationRunService === 'function', 'createOrchestrationRunService is not implemented');
    const row = { run_id: 'run-f', status: 'active' };
    const store = {
      async getRun() { return row; },
      async activeLeaseForRun() { return null; },
      async finishRun(_id, patch) { Object.assign(row, patch); return row; },
    };
    const service = orchestrationRuns.createOrchestrationRunService({ store, now: () => '2026-08-18T20:40:00.000Z' });
    const result = await service.finish({ run_id: 'run-f', disposition: 'clean-stop', last_work_ref: 'LJH-9', last_gate: 'lane:repo-implementation', stop_reason: 'frontier exhausted' });
    assert(result.status === 'finished' && row.last_work_ref === 'LJH-9', 'run continuation was not persisted');
    assert(result.work_authority_changed === false, 'run finish claimed work-authority mutation');
  }));

  results.push(await run('run finish refuses while an active lease is still owned', async () => {
    const row = { run_id: 'run-active', status: 'active' };
    const store = {
      async getRun() { return row; },
      async activeLeaseForRun() { return { lease_id: 'lease-1', work_ref: 'LJH-10', gate: 'lane:repo-implementation', status: 'active', expires_at: '2026-08-18T20:50:00.000Z' }; },
      async finishRun() { throw new Error('finishRun should not be called'); },
    };
    const service = orchestrationRuns.createOrchestrationRunService({ store, now: () => '2026-08-18T20:40:00.000Z' });
    try { await service.finish({ run_id: 'run-active', disposition: 'clean-stop' }); }
    catch (error) { assert(error.code === 'RUN_HAS_ACTIVE_LEASE', `expected RUN_HAS_ACTIVE_LEASE, got ${error.code}`); return; }
    throw new Error('active lease did not fence run finish');
  }));

  results.push(await run('maintenance only performs deterministic bounded reconciliation', async () => {
    assert(typeof orchestrationRuns.createOrchestrationMaintenanceService === 'function', 'createOrchestrationMaintenanceService is not implemented');
    const calls = [];
    const store = {
      async expiredSlots() { return [{ work_ref: 'LJH-1', gate: 'lane:repo-implementation' }]; },
      async stuckLeases() { return [{ kind: 'claiming', claim_request: { work_ref: 'LJH-2', run_id: 'r2', expected_state: 'Todo', expected_lane: 'lane:repo-implementation', lease_seconds: 1800, idempotency_key: 'c2' } }, { kind: 'settling', lease_token: 'token', settle_idempotency_key: 's3', settle_plan: { replay_request: { disposition: 'requeue', evidence: [], reason: null, promotion_condition: null, requeue_class: 'retry_runtime_failure', continuation: null, next_state: null, next_lane: null } } }]; },
      async unresolvedInvocations() { return []; },
    };
    const leases = {
      async reconcileExpired(w,g) { calls.push(['expired',w,g]); return { restored: true }; },
      async claim(req) { calls.push(['claim',req.idempotency_key]); return { ok: true }; },
      async settle(req) { calls.push(['settle',req.idempotency_key]); return { ok: true }; },
    };
    const service = orchestrationRuns.createOrchestrationMaintenanceService({ store, leases, limit: 10 });
    const result = await service.maintain();
    assert(result.ok && result.actions.length === 3, 'maintenance did not reconcile bounded known states');
    assert(calls.map(x=>x[0]).join(',') === 'expired,claim,settle', 'maintenance performed unexpected work');
    assert(result.semantic_work_mutations === 0, 'maintenance claimed semantic portfolio mutation');
  }));

  results.push(await run('maintenance reconciles interrupted orchestration.start from run-record evidence', async () => {
    const updates = [];
    const store = {
      async expiredSlots() { return []; },
      async stuckLeases() { return []; },
      async unresolvedInvocations() { return [{ invocation_id:'inv-start', run_id:'run-start', command:'orchestration.start', outcome:'running' }]; },
      async reconcileInvocation(invocation) { updates.push(invocation.invocation_id); return { reconciled:true, command:'orchestration.start', outcome:'failed', reason:'RUN_RECORD_ABSENT' }; },
    };
    const service = orchestrationRuns.createOrchestrationMaintenanceService({ store, leases:{}, limit:10 });
    const result = await service.maintain();
    assert(updates.length === 1 && result.actions[0]?.kind === 'journal_reconciliation', 'interrupted start was not reconciled');
    assert(result.actions[0]?.result?.reason === 'RUN_RECORD_ABSENT', 'reconciliation did not preserve deterministic absence evidence');
  }));

  results.push(await run('active compatible predecessor is not implicitly transferred to a new run', async () => {
    const rows = new Map([['run-live',{run_id:'run-live',worker:'Repository Implementation',mode:'scheduled',continuation_key:'scheduled:repo',scope:{project:'Portfolio Orchestration',lanes:['lane:repo-implementation'],repositories:[],direction:null},scope_sha256:'placeholder',status:'active',started_at:'2026-08-18T20:00:00.000Z',deadline_at:'2026-08-18T20:45:00.000Z',settlement_reserve_seconds:300,minimum_new_gate_seconds:600}]]);
    const store={async getRun(id){return rows.get(id)||null;},async findPredecessor(){return rows.get('run-live');},async insertRun(row){rows.set(row.run_id,{...row});return rows.get(row.run_id);},async latestHorizon(){return null;}};
    const service=orchestrationRuns.createOrchestrationRunService({store,now:()=> '2026-08-18T20:10:00.000Z'});
    const result=await service.start({run_id:'run-new',worker:'Repository Implementation',mode:'scheduled',continuation_key:'scheduled:repo',scope:{project:'Portfolio Orchestration',lanes:['lane:repo-implementation']}});
    assert(result.predecessor_run_id===null,'live predecessor authority was implicitly transferred');
  }));

  results.push(await run('start replay conflicts when budget semantics differ', async () => {
    const rows=new Map();const store={async getRun(id){return rows.get(id)||null;},async findPredecessor(){return null;},async insertRun(row){rows.set(row.run_id,{...row});return rows.get(row.run_id);},async latestHorizon(){return null;}};
    const service=orchestrationRuns.createOrchestrationRunService({store,now:()=> '2026-08-18T20:00:00.000Z'});
    await service.start({run_id:'run-budget',worker:'Repository Implementation',mode:'scheduled',continuation_key:'scheduled:repo',scope:{project:'Portfolio Orchestration',lanes:['lane:repo-implementation']},budget_seconds:2700});
    try { await service.start({run_id:'run-budget',worker:'Repository Implementation',mode:'scheduled',continuation_key:'scheduled:repo',scope:{project:'Portfolio Orchestration',lanes:['lane:repo-implementation']},budget_seconds:3600}); }
    catch(error){assert(error.code==='IDEMPOTENCY_CONFLICT','changed run budget did not conflict');return;}
    throw new Error('changed run budget replay succeeded');
  }));

  results.push(await run('finish replay conflicts when terminal handoff semantics differ', async () => {
    const row={run_id:'run-finish-idem',status:'active',worker:'Fast Forward',mode:'interactive',continuation_key:'x',scope:{project:'Portfolio Orchestration',lanes:[],repositories:[],direction:null},scope_sha256:'x',started_at:'2026-08-18T20:00:00.000Z',deadline_at:'2026-08-18T21:00:00.000Z',settlement_reserve_seconds:300,minimum_new_gate_seconds:600};
    const store={async getRun(){return row;},async activeLeaseForRun(){return null;},async finishRun(_id,patch){Object.assign(row,patch);return row;}};
    const service=orchestrationRuns.createOrchestrationRunService({store,now:()=> '2026-08-18T20:30:00.000Z'});
    await service.finish({run_id:row.run_id,disposition:'clean-stop',stop_reason:'done'});
    try { await service.finish({run_id:row.run_id,disposition:'failed',stop_reason:'different'}); }
    catch(error){assert(error.code==='IDEMPOTENCY_CONFLICT','changed finish replay did not conflict');return;}
    throw new Error('changed finish replay succeeded');
  }));

  results.push(await run('horizon checkpoint is fenced by registered run scope', async () => {
    const runRow={run_id:'run-scope',status:'active',scope:{project:'Portfolio Orchestration',lanes:['lane:verification'],repositories:[]},deadline_at:'2026-08-18T21:00:00.000Z',settlement_reserve_seconds:300,minimum_new_gate_seconds:600};
    const store={async getRun(){return runRow;},async nextHorizonGeneration(){return 1;},async insertHorizon(row){return row;},async updateRunHorizon(){}};
    const authoritative={async getIssue(){return {identifier:'LJH-1',project:{name:'Portfolio Orchestration'},archivedAt:null,state:{name:'Todo',type:'unstarted'},labels:[{id:'l',name:'lane:repo-implementation'}],priority:2,description:'Repository: owner/repo',relations:[]};}};
    const service=orchestrationRuns.createOrchestrationRunService({store,authoritative,now:()=> '2026-08-18T20:00:00.000Z'});
    try { await service.checkpointHorizon({run_id:'run-scope',candidates:[{work_ref:'LJH-1',expected_state:'Todo',expected_lane:'lane:repo-implementation',selection_reason:'warm_context'}]}); }
    catch(error){assert(error.code==='RUN_SCOPE_VIOLATION','out-of-scope horizon did not fail closed');return;}
    throw new Error('out-of-scope horizon was persisted');
  }));

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}