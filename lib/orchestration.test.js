import {
  executeCorrelatedCommand,
  journalOutcomeFor,
  safeRequestProjection,
  safeResultProjection,
  semanticRequestHash,
} from 'lib/orchestration-journal.js';
import { createOrchestrationResumeService } from 'lib/orchestration-recovery.js';
import * as orchestrationRecovery from 'lib/orchestration-recovery.js';
import { projectOrchestrationStatus } from 'lib/orchestration-status.js';
import * as orchestrationRuns from 'lib/orchestration-runs.js';
import { workLeaseInternals } from 'lib/work-leases.js';
import {
  canonicalClaimCommand,
  canonicalCheckpointCommand,
  canonicalFinishCommand,
  canonicalHeartbeatCommand,
  canonicalHorizonCommand,
  canonicalSettleCommand,
} from 'lib/operator-commands.js';

function assert(condition, message) { if (!condition) throw new Error(message || 'assertion failed'); }
async function run(name, fn) { try { await fn(); return { name, ok: true }; } catch (error) { return { name, ok: false, error: String(error?.message || error) }; } }

class FakeJournal {
  constructor() { this.starts = []; this.finishes = []; }
  async start(row) {
    this.starts.push(JSON.parse(JSON.stringify(row)));
    return { invocation_id: `inv-${this.starts.length}`, sequence: this.starts.length, started_at: '2026-08-17T20:00:00.000Z' };
  }
  async finish(id, body, activity = null) {
    const outcome = body.ok ? 'succeeded' : (String(body.error || '').includes('INDETERMINATE') ? 'indeterminate' : (body.rejection ? 'rejected' : 'failed'));
    this.finishes.push({ id, body: JSON.parse(JSON.stringify(body)), outcome, activity: activity ? JSON.parse(JSON.stringify(activity)) : null });
    return { outcome };
  }
}

function issue(state = 'Todo', lane = 'lane:repo-implementation') {
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
    previous_state: 'Todo', claim_receipt: { ownership_protocol: 'lease-slot-v2', current_state: 'Todo' },
    ...overrides,
  };
}

function operatorDb({ lease = null, claimCount = 0 } = {}) {
  return {
    async query(sql) {
      if (sql.includes('WHERE token_hash')) return { rows: lease ? [lease] : [] };
      if (sql.includes('SELECT claim_idempotency_key')) return { rows: [] };
      if (sql.includes('count(*)::int AS count')) return { rows: [{ count: claimCount }] };
      throw new Error(`unexpected operator test query: ${sql}`);
    },
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

  results.push(await run('semantic claim helper prefers revision fencing and keeps stable logical-attempt identity', async () => {
    const db = operatorDb();
    const a = await canonicalClaimCommand({ work_ref:'LJH-1', run_id:'run-1', observed_revision:'2026-08-20T08:47:53.997Z' }, db);
    const b = await canonicalClaimCommand({ work_ref:'LJH-1', run_id:'run-1', observed_revision:'2026-08-20T08:47:53.997Z' }, db);
    const changed = await canonicalClaimCommand({ work_ref:'LJH-1', run_id:'run-1', observed_revision:'2026-08-20T08:48:00.000Z' }, db);
    assert(a.idempotency_key === b.idempotency_key, 'same logical attempt did not get stable retry identity');
    assert(changed.idempotency_key === a.idempotency_key, 'revision drift escaped the logical attempt identity instead of reaching the request-hash conflict fence');
    assert(a.expected_revision === '2026-08-20T08:47:53.997Z' && a.expected_state === null && a.expected_lane === null, 'revision-first claim retained caller-owned lifecycle/lane bookkeeping');
    let legacyError = null;
    try { await canonicalClaimCommand({ work_ref:'LJH-2', run_id:'run-1', observed_state:'Todo', observed_lane:'lane:repo-implementation' }, db); } catch (error) { legacyError = error; }
    assert(legacyError?.code === 'REQUEST_INVALID', 'semantic claim helper still accepts caller-reconstructed state/lane');
    assert(a.lease_seconds === 1800, 'ordinary bounded lease default was not derived');
  }));

  results.push(await run('semantic progress helpers derive transport bookkeeping from lease identity', async () => {
    const db = operatorDb({ lease: { lease_id:'00000000-0000-4000-8000-000000000001', run_id:'run-1', work_ref:'LJH-1', gate:'lane:repo-implementation', status:'active', expires_at:'2026-08-18T21:00:00.000Z' } });
    const checkpoint = await canonicalCheckpointCommand({ lease_token:'token', phase:'report_ready', next_action:'publish_canonical_jurisdiction_report', evidence:[{kind:'report',ref:'US-CO'}] }, db);
    const heartbeat = await canonicalHeartbeatCommand({ lease_token:'token', phase:'verification', next_action:'run_external_verification', completed:[{kind:'git_head',ref:'abc'}] }, db);
    const settleA = await canonicalSettleCommand({ lease_token:'token', disposition:'completed', evidence:[{kind:'git_head',ref:'abc'}] }, db);
    const settleB = await canonicalSettleCommand({ lease_token:'token', disposition:'blocked', reason:'changed semantics' }, db);
    assert(checkpoint.run_id === 'run-1' && checkpoint.checkpoint.schema === 'work-checkpoint-v1', 'checkpoint did not derive run/schema');
    assert(checkpoint.checkpoint.next_action_kind === 'publish_canonical_jurisdiction_report', 'domain-specific continuation action was not preserved');
    assert(heartbeat.run_id === 'run-1' && heartbeat.extend_seconds === 1800, 'heartbeat did not derive run/default extension');
    assert(settleA.run_id === 'run-1' && settleA.idempotency_key === settleB.idempotency_key, 'one lease did not retain one settlement identity');
    const normalized = workLeaseInternals.normalizeCheckpointRequest(checkpoint);
    assert(normalized.checkpoint.next_action_kind === 'publish_canonical_jurisdiction_report', 'core checkpoint normalizer rejected bounded semantic action');
  }));

  results.push(await run('semantic horizon and finish helpers canonicalize caller-friendly aliases without gaining authority', async () => {
    const horizon = canonicalHorizonCommand({ run_id:'run-h', candidates:[{ work_ref:'LJH-1', observed_state:'Todo', observed_lane:'lane:verification', repository:'caller/repo' }] });
    const finish = canonicalFinishCommand({ run_id:'run-f', disposition:'clean_stop', stop_reason:'frontier exhausted' });
    assert(horizon.candidates[0].expected_state === 'Todo' && horizon.candidates[0].expected_lane === 'lane:verification', 'fresh horizon observation was not canonicalized');
    assert(horizon.candidates[0].selection_reason === 'agent_selected', 'mechanical selection reason default missing');
    assert(!Object.prototype.hasOwnProperty.call(horizon.candidates[0], 'repository'), 'semantic horizon helper retained caller-authored repository bookkeeping');
    assert(finish.disposition === 'clean-stop', 'common finish alias not canonicalized');
  }));

  results.push(await run('correlated success records bounded projection and propagates run_id', async () => {
    const journal = new FakeJournal();
    const response = await executeCorrelatedCommand('github.delete_branch', {
      repo: 'owner/repo', branch: 'feature/x', expected_head: 'a'.repeat(40), run_id: 'run-1',
    }, async () => ({ ok: true, repo: 'owner/repo', branch: 'feature/x', outcome: 'deleted' }), { journal });
    assert(response.body.ok === true && response.body.run_id === 'run-1', 'run_id not propagated');
    assert(journal.starts.length === 1 && journal.finishes.length === 1, 'journal invocation not correlated');
    assert(journal.finishes[0].activity?.run_id === 'run-1' && journal.finishes[0].activity?.command === 'github.delete_branch' && journal.finishes[0].activity?.sequence === 1, 'last durable activity correlation was not forwarded');
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

  results.push(await run('github.apply_changeset result journal projection preserves object-shaped changed paths', async () => {
    for (const idempotent_replay of [false, true]) {
      const projected = safeResultProjection('github.apply_changeset', {
        repo:'owner/repo', branch:'work/239',
        changed_paths:[
          { path:'lib/orchestration-journal.js', operation:'update' },
          { path:'lib/orchestration.test.js', operation:'update' },
        ],
        idempotent_replay,
      });
      assert(projected.changed_path_count === 2, 'changed path count was not preserved');
      assert(JSON.stringify(projected.changed_paths) === JSON.stringify(['lib/orchestration-journal.js','lib/orchestration.test.js']), 'actual changed paths were not preserved');
      assert(projected.idempotent_replay === idempotent_replay, 'replay identity was not preserved');
    }
  }));

  results.push(await run('github review packet journal projection preserves the real nested exact-head response shape', async () => {
    const projected = safeResultProjection('github.review_packet', {
      repo:'owner/repo', pull_request:23,
      base:{ref:'main',sha:'b'.repeat(40)}, head:{ref:'feature/x',sha:'a'.repeat(40)},
      merge:{mergeable:false,merge_state:'dirty'}, review:{decision:'APPROVED'}, checks:{rollup_state:'SUCCESS'},
      snapshot:{sha256:'c'.repeat(64)},
    });
    assert(projected.pull_request === 23, 'review packet pull request identity missing');
    assert(projected.head_sha === 'a'.repeat(40) && projected.base_sha === 'b'.repeat(40), 'nested exact head/base identity was dropped');
    assert(projected.review_decision === 'APPROVED' && projected.merge_state === 'dirty', 'nested review/merge evidence was dropped');
    assert(projected.snapshot_sha256 === 'c'.repeat(64), 'review packet snapshot identity missing');
  }));

  results.push(await run('resume packet does not self-shadow the run it is reconstructing', async () => {
    const journal = new FakeJournal();
    const response = await executeCorrelatedCommand('orchestration.resume_packet', { run_id: 'prior-run' }, async (input) => ({ ok: true, run_id: input.run_id, continuation: 'recompute_frontier' }), { journal });
    assert(response.body.ok === true && response.body.run_id === 'prior-run', 'resume target run_id missing from envelope');
    assert(journal.starts.length === 0 && journal.finishes.length === 0, 'resume call wrote into the target run before reconstruction');
  }));

  results.push(await run('resume packet includes durable skill state without changing recovery authority', async () => {
    const resumeService = { async resume(input) { return { ok:true, run_id:input.run_id, continuation:'recover_active_lease', active_execution:{ lease_id:'lease-1' } }; } };
    const skillService = { async state(input) { return { ok:true, schema:'worker-skill-state-v1', run_id:input.run_id, active:[], completed:[{skill:'systematic-debugging'}], failed:[], remaining_required:[{name:'verification-before-completion'}] }; } };
    const packet = await orchestrationRecovery.orchestrationResumePacket({ run_id:'run-skills' }, { resumeService, skillService });
    assert(packet.continuation==='recover_active_lease','skill enrichment changed recovery continuation');
    assert(packet.skills?.remaining_required?.[0]?.name==='verification-before-completion','resume packet omitted remaining required skill state');
    assert(packet.skills?.completed?.[0]?.skill==='systematic-debugging','resume packet omitted completed skill state');
  }));

  results.push(await run('resume packet preserves historical recovery when no stored skill snapshot exists', async () => {
    const resumeService = { async resume(input) { return { ok:true, run_id:input.run_id, continuation:'terminal_or_quiescent', active_execution:null }; } };
    const skillService = { async state() { const error=new Error('run not found'); error.code='RUN_NOT_FOUND'; throw error; } };
    const packet = await orchestrationRecovery.orchestrationResumePacket({ run_id:'historical-run' }, { resumeService, skillService });
    assert(packet.continuation==='terminal_or_quiescent','historical skill fallback changed recovery continuation');
    assert(packet.skills?.policy?.source==='historical_unknown'&&packet.skills?.remaining_required?.length===0,'historical run acquired a retroactive skill requirement');
  }));

  results.push(await run('diagnosis does not self-shadow the failure evidence it is classifying', async () => {
    const journal = new FakeJournal();
    const response = await executeCorrelatedCommand('orchestration.diagnose', { run_id: 'prior-run', work_ref:'LJH-370' }, async (input) => ({ ok:true, run_id:input.run_id, failure_state:'CLAIM_STATE_INVALID', recovery_operation:{command:'work.claim'} }), { journal });
    assert(response.body.ok === true && response.body.failure_state === 'CLAIM_STATE_INVALID', 'diagnosis response was not preserved');
    assert(journal.starts.length === 0 && journal.finishes.length === 0, 'diagnosis call wrote into the target run before classifying its evidence');
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

  results.push(await run('legacy active lease still recovers against In Progress authority', async () => {
    const lease = activeLease({ claim_receipt: { current_state: 'In Progress' } });
    const service = resumeHarness(lease, {
      slot: { lease_id: lease.lease_id, expires_at: lease.expires_at },
      linearIssue: issue('In Progress'),
    });
    const packet = await service.resume({ run_id: 'run-1' });
    assert(packet.continuation === 'recover_active_lease', 'legacy active lease lost recovery compatibility');
    assert(packet.active_execution.lease_token === 'wlt_SECRET_TOKEN', 'legacy recovered lease token missing');
  }));

  results.push(await run('slot-only active lease rejects a legacy In Progress authority mismatch', async () => {
    const lease = activeLease();
    const service = resumeHarness(lease, {
      slot: { lease_id: lease.lease_id, expires_at: lease.expires_at },
      linearIssue: issue('In Progress'),
    });
    const packet = await service.resume({ run_id: 'run-1' });
    assert(packet.continuation === 'owner_action_required', 'slot-only lease silently accepted the wrong Linear state');
    const mismatch = packet.evidence.find((item) => item.kind === 'lease_authority_mismatch');
    assert(mismatch?.expected_state === 'Todo', 'slot-only recovery did not report the Todo authority contract');
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
      overdue_active_runs: [{ run_id: 'r0', worker: 'Fast Forward', mode: 'interactive', deadline_at: stamp, updated_at: stamp, last_work_ref: 'LJH-0', last_gate: 'lane:x', has_live_lease: false, observed_at: stamp }],
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
    rows.get('run-a').status = 'finished';
    const second = await service.start({ run_id: 'run-b', worker: 'Repository Implementation', mode: 'scheduled', continuation_key: 'scheduled:repo', scope: { project: 'Portfolio Orchestration', lanes: ['lane:repo-implementation'] } });
    assert(second.predecessor_run_id === 'run-a', 'compatible finished predecessor was not recovered');
    assert(first.contract_provenance?.status === 'not_supplied', 'missing worker contract provenance was guessed instead of marked unknown');
  }));

  results.push(await run('run start accepts team-wide campaign scope without requiring the legacy project container', async () => {
    const rows = new Map();
    const store = { async getRun(id){return rows.get(id)||null;}, async findPredecessor(){return null;}, async insertRun(row){rows.set(row.run_id,{...row});return rows.get(row.run_id);}, async latestHorizon(){return null;} };
    const service = orchestrationRuns.createOrchestrationRunService({ store, now: () => '2026-08-18T20:00:00.000Z' });
    const started = await service.start({ run_id:'run-campaign-scope', worker:'Fast Forward', mode:'interactive', continuation_key:'campaign', scope:{team:'Ljh-projects',projects:['U.S. Jurisdiction Coverage','STE-Lint Complete'],lanes:['lane:repo-implementation']} });
    assert(started.scope?.team==='Ljh-projects','team scope was not persisted');
    assert(started.scope?.projects?.join(',')==='STE-Lint Complete,U.S. Jurisdiction Coverage','campaign projects were not normalized');
    assert(started.scope?.project===undefined,'new scope was collapsed back into the legacy project field');
  }));

  results.push(await run('run start stores declared worker contract provenance immutably without changing execution semantics', async () => {
    const rows = new Map();
    const store = { async getRun(id){return rows.get(id)||null;}, async findPredecessor(){return null;}, async insertRun(row){rows.set(row.run_id,{...row});return rows.get(row.run_id);}, async latestHorizon(){return null;} };
    const service = orchestrationRuns.createOrchestrationRunService({ store, now: () => '2026-08-18T20:00:00.000Z' });
    const provenance = {
      project_instructions: { file_id: 'project-file', revision_id: 'project-rev' },
      fast_forward_skill: { file_id: 'ff-file', revision_id: 'ff-rev' },
      execution_ownership_skill: { file_id: 'ownership-file', revision_id: 'ownership-rev' },
    };
    const first = await service.start({ run_id:'run-provenance', worker:'Fast Forward', mode:'interactive', continuation_key:'ff', scope:{project:'Portfolio Orchestration'}, contract_provenance:provenance });
    assert(first.contract_provenance?.status === 'declared' && first.contract_provenance?.worker_transport_revision === 'worker-transport-v2', 'declared contract provenance was not normalized');
    assert(first.contract_provenance?.fast_forward_skill?.revision_id === 'ff-rev', 'declared skill revision was not persisted');
    const replay = await service.start({ run_id:'run-provenance', worker:'Fast Forward', mode:'interactive', continuation_key:'ff', scope:{project:'Portfolio Orchestration'} });
    assert(replay.idempotent_replay === true && replay.contract_provenance?.fast_forward_skill?.revision_id === 'ff-rev', 'run replay rewrote immutable contract provenance');
  }));

  results.push(await run('run start derives an immutable server-owned skill policy for implementation workers', async () => {
    const rows = new Map();
    const store = { async getRun(id){return rows.get(id)||null;}, async findPredecessor(){return null;}, async insertRun(row){rows.set(row.run_id,{...row});return rows.get(row.run_id);}, async latestHorizon(){return null;} };
    const service = orchestrationRuns.createOrchestrationRunService({ store, now: () => '2026-08-18T20:00:00.000Z' });
    const first = await service.start({ run_id:'run-skills', worker:'Repository Implementation', mode:'interactive', continuation_key:'skills', scope:{project:'Portfolio Orchestration'} });
    assert(first.skill_policy?.source === 'server', 'skill policy was not derived by the server');
    assert(first.skill_policy?.required?.some((entry)=>entry.name==='verification-before-completion'&&entry.required_before==='work.complete'), 'verification-before-completion is not a completion invariant');
    assert(first.skill_policy?.available?.some((entry)=>entry.name==='systematic-debugging'), 'implementation debugging skill is not available');
    const stored = rows.get('run-skills');
    assert(stored.skill_policy?.catalog_revision === first.skill_policy?.catalog_revision, 'pinned skill catalog was not persisted with the run');
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
    assert(checkpoint.candidates[0].repository === 'owner/repo', 'horizon did not derive repository from authoritative execution projection');
    assert(checkpoint.candidates[0].execution_fingerprint?.length === 64, 'horizon did not retain execution fingerprint');
    assert(checkpoint.ownership_granted === false, 'horizon accidentally granted ownership');
    const valid = await service.resolveHorizon({ run_id: 'run-h' });
    assert(valid.candidates[0].status === 'valid', 'unchanged horizon entry was not reusable');
    current.priority = 1;
    const stale = await service.resolveHorizon({ run_id: 'run-h' });
    assert(stale.candidates[0].status === 'materially_changed', 'changed authority did not invalidate horizon entry');
  }));

  results.push(await run('horizon checkpoint rejects disposed repository before Fast Forward or scheduled reuse', async () => {
    const runRow = { run_id:'run-disposed-h', status:'active', scope:{project:'Portfolio Orchestration',lanes:['lane:repo-implementation'],repositories:[]} };
    const store = { async getRun(){return runRow;}, async nextHorizonGeneration(){return 1;}, async insertHorizon(row){return row;}, async updateRunHorizon(){} };
    const authoritative = { async getIssue(){return {identifier:'LJH-DISPOSED',project:{name:'Portfolio Orchestration'},archivedAt:null,state:{name:'Todo',type:'unstarted'},labels:[{id:'l',name:'lane:repo-implementation'}],priority:2,description:'Repository: owner/dead-repo\n\nAcceptance: bounded',relations:[]};} };
    const repositoryLifecycle = { async observe(){return {repository:'owner/dead-repo',disposition:'ARCHIVED',ordinary_work_enabled:false,successor_repository:null,compatibility_bound:false};} };
    const service = orchestrationRuns.createOrchestrationRunService({ store, authoritative, repositoryLifecycle, now:()=> '2026-08-18T20:00:00.000Z' });
    let error=null; try { await service.checkpointHorizon({run_id:'run-disposed-h',candidates:[{work_ref:'LJH-DISPOSED',expected_state:'Todo',expected_lane:'lane:repo-implementation',selection_reason:'frontier'}]}); } catch(e){error=e;}
    assert(error?.code==='REPOSITORY_DISPOSED','disposed repository was admitted to an advisory horizon');
  }));

  results.push(await run('stored horizon becomes no_longer_executable when repository is disposed', async () => {
    const runRow = { run_id:'run-disposed-resolve', status:'active', scope:{project:'Portfolio Orchestration',lanes:['lane:repo-implementation'],repositories:[]} };
    let saved=null; let disposed=false;
    const store = { async getRun(){return runRow;}, async nextHorizonGeneration(){return 1;}, async insertHorizon(row){saved={...row};return saved;}, async latestHorizon(){return saved;}, async updateRunHorizon(){} };
    const authoritative = { async getIssue(){return {identifier:'LJH-DISPOSED',project:{name:'Portfolio Orchestration'},archivedAt:null,state:{name:'Todo',type:'unstarted'},labels:[{id:'l',name:'lane:repo-implementation'}],priority:2,description:'Repository: owner/dead-repo\n\nAcceptance: bounded',relations:[]};} };
    const repositoryLifecycle = { async observe(){return {repository:'owner/dead-repo',disposition:disposed?'ARCHIVED':'ACTIVE',ordinary_work_enabled:!disposed,successor_repository:null,compatibility_bound:false};} };
    const service = orchestrationRuns.createOrchestrationRunService({ store, authoritative, repositoryLifecycle, now:()=> '2026-08-18T20:00:00.000Z' });
    await service.checkpointHorizon({run_id:'run-disposed-resolve',candidates:[{work_ref:'LJH-DISPOSED',expected_state:'Todo',expected_lane:'lane:repo-implementation',selection_reason:'frontier'}]});
    disposed=true;
    const resolved=await service.resolveHorizon({run_id:'run-disposed-resolve'});
    assert(resolved.candidates[0].status==='no_longer_executable'&&resolved.candidates[0].repository_disposition==='ARCHIVED','disposed horizon entry remained reusable');
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

  results.push(await run('run receipt derives bounded settlement evidence instead of trusting handoff prose', async () => {
    const row = { run_id:'run-receipt', status:'finished', disposition:'completed', worker:'Repository Implementation', mode:'scheduled', started_at:'2026-08-18T20:00:00.000Z', deadline_at:'2026-08-18T20:45:00.000Z', finished_at:'2026-08-18T20:30:00.000Z' };
    const store = {
      async getRun() { return row; },
      async leasesForRun() { return [{ lease_id:'lease-1', work_ref:'LJH-9', gate:'lane:repo-implementation', status:'settled', created_at:'2026-08-18T20:05:00.000Z', settled_at:'2026-08-18T20:25:00.000Z', settle_plan:{ evidence:[{kind:'git_head',ref:'abc123'}] }, settle_receipt:{ disposition:'completed', current_state:'Todo', current_lane:'lane:verification', settlement_authoritative_revision:'2026-08-18T20:24:59.000Z', successor_execution_fingerprint:'f'.repeat(64), execution_precondition_verified:true } }]; },
      async invocationsForRun() { return [{ sequence:1, command:'work.claim', outcome:'succeeded', resolved:false }, { sequence:2, command:'work.settle', outcome:'succeeded', resolved:false }]; },
    };
    const service = orchestrationRuns.createOrchestrationRunService({ store });
    const receipt = await service.receipt({ run_id:'run-receipt' });
    assert(receipt.schema === 'orchestration-run-receipt-v1', 'run receipt schema missing');
    assert(receipt.evidence_status === 'complete' && receipt.unproven.length === 0, 'fully settled run was not evidence-complete');
    assert(receipt.settlements.length === 1 && receipt.settlements[0].work_ref === 'LJH-9', 'settlement evidence missing');
    assert(receipt.settlements[0].evidence_refs[0]?.ref === 'abc123', 'bounded settlement evidence ref missing');
    assert(receipt.settlements[0].authority_after?.revision === '2026-08-18T20:24:59.000Z', 'authoritative settlement revision missing');
    assert(receipt.receipt_sha256?.length === 64, 'receipt is not digest-bound');
    assert(!JSON.stringify(receipt).includes('lease_token'), 'run receipt leaked a lease capability');
  }));

  results.push(await run('run finish returns its derived evidence receipt', async () => {
    const row = { run_id:'run-finish-receipt', status:'active', worker:'Repository Implementation', mode:'scheduled', started_at:'2026-08-18T20:00:00.000Z', deadline_at:'2026-08-18T20:45:00.000Z' };
    const store = {
      async getRun() { return row; },
      async activeLeaseForRun() { return null; },
      async finishRun(_id, patch) { Object.assign(row, patch); return row; },
      async leasesForRun() { return []; },
      async invocationsForRun() { return []; },
    };
    const service = orchestrationRuns.createOrchestrationRunService({ store, now:()=> '2026-08-18T20:30:00.000Z' });
    const result = await service.finish({ run_id:row.run_id, disposition:'no-work', stop_reason:'frontier exhausted' });
    assert(result.run_receipt?.schema === 'orchestration-run-receipt-v1', 'finish did not return a derived run receipt');
    assert(result.run_receipt.evidence_status === 'complete', 'clean no-work finish was not evidence-complete');
  }));

  results.push(await run('run receipt derives external effects and authority observations from safe journal projections', async () => {
    const row = { run_id:'run-effects', status:'finished', disposition:'completed', worker:'Portfolio Integration', mode:'scheduled', started_at:'2026-08-18T20:00:00.000Z', finished_at:'2026-08-18T20:30:00.000Z' };
    const store = {
      async getRun() { return row; },
      async leasesForRun() { return []; },
      async invocationsForRun() { return [
        { sequence:1, command:'github.review_packet', target_ref:'owner/repo', outcome:'succeeded', resolved:false, request_projection:{repo:'owner/repo',pull_number:7,expected_head:'a'.repeat(40)}, result_projection:{repo:'owner/repo',pull_number:7,head_sha:'a'.repeat(40),review_decision:'APPROVED'} },
        { sequence:2, command:'github.apply_changeset', target_ref:'owner/repo', outcome:'succeeded', resolved:false, request_projection:{repo:'owner/repo',branch:'feature/x',expected_head:'a'.repeat(40),changed_paths:['src/a.js']}, result_projection:{repo:'owner/repo',branch:'feature/x',previous_head:'a'.repeat(40),new_head:'b'.repeat(40),changed_paths:['src/a.js']} },
      ]; },
    };
    const receipt = await orchestrationRuns.createOrchestrationRunService({ store }).receipt({ run_id:'run-effects' });
    assert(receipt.external_effects?.length === 1 && receipt.external_effects[0].command === 'github.apply_changeset', 'write-capable journal effect was not derived');
    assert(receipt.external_effects[0].result?.new_head === 'b'.repeat(40), 'exact durable GitHub result identity missing');
    assert(receipt.external_effects[0].request?.changed_paths?.[0] === 'src/a.js', 'safe request projection missing from external effect');
    assert(receipt.authority_observations?.length === 1 && receipt.authority_observations[0].command === 'github.review_packet', 'read-only authority observation was not derived');
    assert(receipt.authority_observations[0].result?.head_sha === 'a'.repeat(40), 'exact-head observation missing');
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
    catch (error) {
      assert(error.code === 'RUN_HAS_ACTIVE_LEASE', `expected RUN_HAS_ACTIVE_LEASE, got ${error.code}`);
      assert(error.details?.lease_ref === 'lease-1' && error.details?.required_command === 'orchestration.finish', 'finish rejection did not expose the safe settlement transition');
      assert(error.details?.required_transition === 'retry_finish_with_active_lease_settlement' && error.details?.required_field === 'active_lease_settlement.disposition', 'finish rejection did not define the cleanup state transition');
      return;
    }
    throw new Error('active lease did not fence run finish');
  }));

  results.push(await run('settlement-aware finish settles the owned lease before terminalizing the run', async () => {
    const row = { run_id:'run-settle-finish', status:'active', worker:'Fast Forward', mode:'interactive' };
    let active = { lease_id:'lease-finish', work_ref:'LJH-10', gate:'lane:repo-implementation', status:'active', expires_at:'2026-08-18T20:50:00.000Z' };
    const store = {
      async getRun(){ return row; },
      async activeLeaseForRun(){ return active; },
      async finishRun(_id,patch){ Object.assign(row,patch); return row; },
      async leasesForRun(){ return []; },
      async invocationsForRun(){ return []; },
    };
    const settlements = [];
    const leases = {
      async settleByRef(request){ settlements.push(request); active = null; return { ok:true, lease_id:'lease-finish', disposition:request.disposition }; },
    };
    const service = orchestrationRuns.createOrchestrationRunService({ store, leases, now:()=> '2026-08-18T20:40:00.000Z' });
    const result = await service.finish({
      run_id:row.run_id,
      disposition:'clean-stop',
      stop_reason:'checkpointed work returned to frontier',
      active_lease_settlement:{ disposition:'requeue', requeue_class:'resume_progress', evidence:[] },
    });
    assert(settlements.length === 1, 'finish did not structurally settle its active lease');
    assert(settlements[0].lease_ref === 'lease-finish' && settlements[0].requeue_class === 'resume_progress', 'finish settlement did not target the exact owned lease');
    assert(row.status === 'finished' && result.status === 'finished', 'run terminalized incorrectly after safe settlement');
  }));

  results.push(await run('settlement-aware finish never terminalizes the run when lease settlement fails', async () => {
    const row = { run_id:'run-settle-fails', status:'active', worker:'Fast Forward', mode:'interactive' };
    const active = { lease_id:'lease-fails', work_ref:'LJH-11', gate:'lane:repo-implementation', status:'active', expires_at:'2026-08-18T20:50:00.000Z' };
    let finishCalls = 0;
    const store = {
      async getRun(){ return row; },
      async activeLeaseForRun(){ return active; },
      async finishRun(){ finishCalls += 1; return row; },
      async leasesForRun(){ return []; },
      async invocationsForRun(){ return []; },
    };
    const leases = { async settleByRef(){ const error = new Error('settlement conflict'); error.code='WORK_STATE_CHANGED'; throw error; } };
    const service = orchestrationRuns.createOrchestrationRunService({ store, leases, now:()=> '2026-08-18T20:40:00.000Z' });
    let failure = null;
    try {
      await service.finish({ run_id:row.run_id, disposition:'clean-stop', active_lease_settlement:{ disposition:'requeue', requeue_class:'resume_progress', evidence:[] } });
    } catch (error) { failure = error; }
    assert(failure?.code === 'WORK_STATE_CHANGED', 'settlement failure was hidden or rewritten');
    assert(finishCalls === 0 && row.status === 'active', 'run terminalized after lease settlement failed');
  }));

  results.push(await run('orchestration diagnosis turns heartbeat exhaustion into exact checkpoint-preserving settlement', async () => {
    assert(typeof orchestrationRecovery.createOrchestrationDiagnosisService === 'function', 'diagnosis service is not implemented');
    const lease = activeLease({ lease_id:'lease-diagnose', work_ref:'LJH-370', gate:'lane:source-implementation' });
    const runRow = { run_id:'run-1', status:'active', disposition:null, worker:'Source and Data Implementation', last_work_ref:'LJH-370', last_gate:'lane:source-implementation' };
    const failure = { sequence:7, command:'work.heartbeat', outcome:'rejected', error_code:'HEARTBEAT_LIMIT_REACHED', retryable:false, rejection:true, may_have_mutated:false, started_at:'2026-08-17T20:25:00.000Z', completed_at:'2026-08-17T20:25:01.000Z' };
    const store = {
      async getRun(){ return runRow; },
      async lastSuccessfulInvocation(){ return { sequence:6, command:'work.checkpoint', outcome:'succeeded', started_at:'2026-08-17T20:24:00.000Z', completed_at:'2026-08-17T20:24:01.000Z' }; },
      async recentFailures(){ return [failure]; },
      async latestLease(){ return lease; },
      async latestCheckpoint(){ return { checkpoint_sha256:'c'.repeat(64), created_at:'2026-08-17T20:24:00.000Z', checkpoint:{schema:'work-checkpoint-v1',phase:'verification',next_action_kind:'continue'} }; },
      async slot(){ return { lease_id:lease.lease_id, expires_at:lease.expires_at }; },
    };
    const authoritative = { async getIssue(){ return { identifier:'LJH-370', updatedAt:'2026-08-17T20:24:59.000Z', state:{name:'Todo'}, labels:[{name:'lane:source-implementation'}] }; } };
    const diagnosis = await orchestrationRecovery.createOrchestrationDiagnosisService({store,authoritative,now:()=> '2026-08-17T20:30:00.000Z'}).diagnose({run_id:'run-1'});
    assert(diagnosis.failure_state === 'HEARTBEAT_BUDGET_EXHAUSTED', `heartbeat diagnosis was ${diagnosis.failure_state}`);
    assert(diagnosis.active_lease?.lease_id === 'lease-diagnose', 'diagnosis lost active lease identity');
    assert(diagnosis.recovery_operation?.command === 'work.settle', 'diagnosis did not prescribe settlement');
    assert(diagnosis.recovery_operation?.input?.lease_ref === 'lease-diagnose' && diagnosis.recovery_operation?.input?.requeue_class === 'resume_progress', 'diagnosis did not return exact checkpoint-preserving settlement input');
    assert(diagnosis.automatic_recovery_allowed === true && diagnosis.escalation_required === false, 'known heartbeat exhaustion escalated to reasoning');
  }));

  results.push(await run('orchestration diagnosis classifies stale lease and transient transport without permanent disablement', async () => {
    const expired = activeLease({ lease_id:'lease-stale', expires_at:'2026-08-17T20:10:00.000Z' });
    const baseRun = { run_id:'run-1', status:'active', disposition:null, worker:'Repository Implementation', last_work_ref:'LJH-1', last_gate:'lane:repo-implementation' };
    const staleStore = {
      async getRun(){return baseRun;}, async lastSuccessfulInvocation(){return null;}, async recentFailures(){return[];}, async latestLease(){return expired;}, async latestCheckpoint(){return null;}, async slot(){return {lease_id:expired.lease_id,expires_at:expired.expires_at};},
    };
    const authoritative = { async getIssue(){return issue();} };
    const stale = await orchestrationRecovery.createOrchestrationDiagnosisService({store:staleStore,authoritative,now:()=> '2026-08-17T20:30:00.000Z'}).diagnose({run_id:'run-1'});
    assert(stale.failure_state === 'STALE_LEASE' && stale.recovery_operation?.command === 'orchestration.maintain', 'stale lease did not use canonical reconciliation');

    const transportStore = {
      async getRun(){return baseRun;},
      async lastSuccessfulInvocation(){return {sequence:4,command:'orchestration.start',outcome:'succeeded'};},
      async recentFailures(){return [{sequence:5,command:'work.claim',outcome:'failed',error_code:'HATCHABLE_MCP_TRANSPORT_ERROR',may_have_mutated:false}];},
      async latestLease(){return null;}, async latestCheckpoint(){return null;}, async slot(){return null;},
    };
    const transport = await orchestrationRecovery.createOrchestrationDiagnosisService({store:transportStore,authoritative,now:()=> '2026-08-17T20:30:00.000Z'}).diagnose({run_id:'run-1'});
    assert(transport.failure_state === 'TRANSPORT_UNAVAILABLE' && transport.worker_state === 'degraded', 'transient transport outage was not degraded/retryable');
    assert(transport.automatic_recovery_allowed === true && transport.recovery_operation?.mode === 'bounded_retry_same_request', 'transient outage did not get bounded retry');
  }));

  results.push(await run('repeated recovery failure escalates and later success clears degraded current state', async () => {
    const runRow = { run_id:'run-retry', status:'active', worker:'Repository Implementation' };
    const failures = [7,6,5].map(sequence=>({sequence,command:'work.claim',outcome:'failed',error_code:'HATCHABLE_MCP_TRANSPORT_ERROR',may_have_mutated:false}));
    const store = { async getRun(){return runRow;}, async lastSuccessfulInvocation(){return {sequence:4,command:'orchestration.start',outcome:'succeeded'};}, async recentFailures(){return failures;}, async latestLease(){return null;}, async latestCheckpoint(){return null;}, async slot(){return null;} };
    const authoritative = { async getIssue(){return issue();} };
    const diagnosis = await orchestrationRecovery.createOrchestrationDiagnosisService({store,authoritative}).diagnose({run_id:'run-retry'});
    assert(diagnosis.failure_state === 'RECOVERY_FAILED' && diagnosis.escalation_required === true, 'bounded repeated recovery did not escalate');

    store.lastSuccessfulInvocation = async()=>({sequence:8,command:'work.claim',outcome:'succeeded'});
    const recovered = await orchestrationRecovery.createOrchestrationDiagnosisService({store,authoritative}).diagnose({run_id:'run-retry'});
    assert(recovered.failure_state === null && recovered.worker_state === 'enabled' && recovered.automatic_recovery_allowed === false, 'later success did not clear current degraded failure state');
  }));

  results.push(await run('abandoned historical run is classified unobservable without speculative investigation', async () => {
    const store = {
      async getRun(){return {run_id:'run-zombie',status:'finished',disposition:'abandoned',worker:'Fast Forward',stop_reason:'RUN_DEADLINE_ELAPSED_NO_CLEAN_FINISH: historical evidence'};},
      async lastSuccessfulInvocation(){return {sequence:3,command:'github.review_packet',outcome:'succeeded'};}, async recentFailures(){return[];}, async latestLease(){return null;}, async latestCheckpoint(){return null;}, async slot(){return null;},
    };
    const diagnosis = await orchestrationRecovery.createOrchestrationDiagnosisService({store,authoritative:{async getIssue(){return null;}}}).diagnose({run_id:'run-zombie'});
    assert(diagnosis.historical_classification === 'UNOBSERVABLE_SESSION_TERMINATION', 'historical cessation was not classified as unobservable');
    assert(diagnosis.investigation_required === false && diagnosis.escalation_required === false, 'historical unobservable cessation remained an investigation queue');
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

  results.push(await run('maintenance never reconciles a receipt whose semantic request hash differs', async () => {
    const queries=[];
    const db={async query(sql){queries.push(sql);if(sql.includes('claim_receipt AS receipt'))return {rows:[{receipt:{ok:true},request_sha256:'stored-hash'}]};return {rows:[]};}};
    const store=orchestrationRuns.createPostgresOrchestrationMaintenanceStore(db);
    const result=await store.reconcileInvocation({invocation_id:'00000000-0000-4000-8000-000000000010',command:'work.claim',idempotency_key:'claim-x',request_sha256:'journal-hash',outcome:'running'});
    assert(result===null,'mismatched durable receipt was incorrectly attributed to journal invocation');
    assert(!queries.some(sql=>sql.includes('INSERT INTO orchestration_invocation_resolutions')),'hash mismatch was incorrectly marked resolved');
  }));

  results.push(await run('overdue abandoned run is terminalized once without changing continuation evidence', async () => {
    const row={run_id:'run-zombie',worker:'Fast Forward',mode:'interactive',continuation_key:'ff',scope:{project:'Portfolio Orchestration',lanes:[],repositories:[],direction:'continue'},scope_sha256:'scope-z',status:'active',disposition:null,started_at:'2026-08-18T19:00:00.000Z',deadline_at:'2026-08-18T20:00:00.000Z',last_work_ref:'LJH-77',last_gate:'lane:verification',latest_horizon_id:'00000000-0000-4000-8000-000000000077',predecessor_run_id:'run-prior',finished_at:null};
    const before=JSON.parse(JSON.stringify(row));
    const store={
      async expiredSlots(){return[];},async stuckLeases(){return[];},async unresolvedInvocations(){return[];},
      async overdueRuns(at){return row.status==='active'&&Date.parse(row.deadline_at)<=Date.parse(at)?[row]:[];},
      async reconcileAbandonedRun(_id,at){if(row.status!=='active'||Date.parse(row.deadline_at)>Date.parse(at))return null;Object.assign(row,{status:'finished',disposition:'abandoned',stop_reason:'RUN_DEADLINE_ELAPSED_NO_CLEAN_FINISH',finished_at:at,updated_at:at});return row;},
    };
    const service=orchestrationRuns.createOrchestrationMaintenanceService({store,leases:{},limit:10,now:()=> '2026-08-18T20:30:00.000Z'});
    const first=await service.maintain();
    const second=await service.maintain();
    assert(first.actions.length===1&&first.actions[0].kind==='abandoned_run_reconciliation','overdue run was not reconciled');
    assert(first.actions[0].result.status==='finished'&&first.actions[0].result.disposition==='abandoned','maintenance action did not report bounded terminal state');
    assert(second.actions.length===0,'repeated maintenance changed an already terminal run');
    for(const key of ['last_work_ref','last_gate','latest_horizon_id','predecessor_run_id','continuation_key','scope_sha256'])assert(row[key]===before[key],`${key} was not preserved`);
    assert(JSON.stringify(row.scope)===JSON.stringify(before.scope),'scope was not preserved');
    assert(first.semantic_work_mutations===0&&first.work_selection_performed===false,'run reconciliation claimed portfolio work authority');
    assert(!JSON.stringify(first.actions[0]).includes('lease_token'),'maintenance action leaked a capability token');
  }));

  results.push(await run('run reconciliation ignores future runs and overdue runs with live lease ownership', async () => {
    const now='2026-08-18T20:30:00.000Z';
    const future={run_id:'future',status:'active',deadline_at:'2026-08-18T21:00:00.000Z'};
    const leased={run_id:'leased',status:'active',deadline_at:'2026-08-18T20:00:00.000Z'};
    let live=true;
    const store={
      async expiredSlots(){return[];},async stuckLeases(){return[];},async unresolvedInvocations(){return[];},
      async overdueRuns(){return[leased];},
      async reconcileAbandonedRun(){if(live)return null;leased.status='finished';leased.disposition='abandoned';return leased;},
    };
    const service=orchestrationRuns.createOrchestrationMaintenanceService({store,leases:{},limit:10,now:()=>now});
    const r=await service.maintain();
    assert(r.actions.length===0&&leased.status==='active','live leased run was terminalized');
    assert(future.status==='active','future run was changed');
  }));

  results.push(await run('terminalized abandoned run remains eligible as continuation predecessor', async () => {
    const rows=new Map();
    const store={
      async getRun(id){return rows.get(id)||null;},
      async findPredecessor(key,scopeSha,exclude){return [...rows.values()].filter(r=>r.continuation_key===key&&r.scope_sha256===scopeSha&&r.run_id!==exclude&&(r.status==='finished'||Date.parse(r.deadline_at)<=Date.parse('2026-08-18T20:31:00.000Z'))).sort((a,b)=>String(b.started_at).localeCompare(String(a.started_at)))[0]||null;},
      async insertRun(r){rows.set(r.run_id,{...r});return rows.get(r.run_id);},async latestHorizon(){return null;},
      async expiredSlots(){return[];},async stuckLeases(){return[];},async unresolvedInvocations(){return[];},
      async overdueRuns(at){return [...rows.values()].filter(r=>r.status==='active'&&Date.parse(r.deadline_at)<=Date.parse(at));},
      async reconcileAbandonedRun(id,at){const r=rows.get(id);if(!r||r.status!=='active')return null;Object.assign(r,{status:'finished',disposition:'abandoned',stop_reason:'RUN_DEADLINE_ELAPSED_NO_CLEAN_FINISH',finished_at:at,updated_at:at});return r;},
    };
    const firstService=orchestrationRuns.createOrchestrationRunService({store,now:()=> '2026-08-18T20:00:00.000Z'});
    await firstService.start({run_id:'old-run',worker:'Fast Forward',mode:'interactive',continuation_key:'ff:key',scope:{project:'Portfolio Orchestration',lanes:[]},budget_seconds:900});
    await orchestrationRuns.createOrchestrationMaintenanceService({store,leases:{},now:()=> '2026-08-18T20:30:00.000Z'}).maintain();
    const secondService=orchestrationRuns.createOrchestrationRunService({store,now:()=> '2026-08-18T20:31:00.000Z'});
    const next=await secondService.start({run_id:'new-run',worker:'Fast Forward',mode:'interactive',continuation_key:'ff:key',scope:{project:'Portfolio Orchestration',lanes:[]},budget_seconds:900});
    assert(rows.get('old-run').status==='finished'&&next.predecessor_run_id==='old-run','abandoned historical run was lost to predecessor recovery');
  }));

  results.push(await run('status reports overdue active runs as unhealthy with bounded evidence', async () => {
    const status=projectOrchestrationStatus({overdue_active_runs:[{run_id:'z',worker:'Fast Forward',mode:'interactive',deadline_at:'2026-08-18T20:00:00.000Z',updated_at:'2026-08-18T20:01:00.000Z',last_work_ref:'LJH-1',last_gate:'lane:verification',last_durable_activity_at:'2026-08-18T19:42:00.000Z',last_durable_activity_type:'work.heartbeat:succeeded',has_live_lease:false,scope:{secret:'large'},lease_token:'wlt_SECRET',observed_at:'2026-08-18T20:00:00.000Z'}]});
    assert(status.healthy===false&&status.conditions.overdue_active_runs.count===1,'overdue active run did not make status unhealthy');
    const projected=status.conditions.overdue_active_runs.oldest_refs[0];
    assert(projected.last_durable_activity_at==='2026-08-18T19:42:00.000Z'&&projected.last_durable_activity_type==='work.heartbeat:succeeded','status omitted the last durable worker activity evidence');
    const encoded=JSON.stringify(projected);
    assert(!encoded.includes('wlt_SECRET')&&!encoded.includes('secret'),'status leaked unbounded/internal run state');
    const healthy=projectOrchestrationStatus({overdue_active_runs:[]});
    assert(healthy.healthy===true,'empty overdue condition produced false unhealthy status');
  }));

  results.push(await run('Postgres abandoned-run reconciliation locks the run row and revalidates live lease absence atomically', async () => {
    let ops=[];
    const fakeDb={async query(){return{rows:[]};},async transaction(items){ops=items;return{results:[{rows:[{run_id:'run-race'}]},{rows:[{run_id:'run-race',status:'finished',disposition:'abandoned',finished_at:'2026-08-18T20:30:00.000Z'}]}]};}};
    const store=orchestrationRuns.createPostgresOrchestrationMaintenanceStore(fakeDb);
    const result=await store.reconcileAbandonedRun('run-race','2026-08-18T20:30:00.000Z');
    assert(result?.disposition==='abandoned'&&ops.length===2,'abandoned run transaction did not execute');
    assert(/FOR UPDATE/i.test(ops[0].sql)&&/orchestration_runs/i.test(ops[0].sql),'maintenance did not lock the run row');
    assert(/NOT EXISTS/i.test(ops[1].sql)&&/work_leases/i.test(ops[1].sql)&&/claiming/.test(ops[1].sql)&&/active/.test(ops[1].sql)&&/settling/.test(ops[1].sql),'maintenance did not atomically revalidate shared lease liveness');
    assert(!/last_work_ref\s*=|last_gate\s*=|latest_horizon_id\s*=|continuation_key\s*=|scope\s*=|scope_sha256\s*=/i.test(ops[1].sql),'reconciliation SQL overwrites continuation evidence');
  }));

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}