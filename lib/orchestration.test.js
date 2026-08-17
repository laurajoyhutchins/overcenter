import {
  executeCorrelatedCommand,
  journalOutcomeFor,
  safeRequestProjection,
  safeResultProjection,
  semanticRequestHash,
} from 'lib/orchestration-journal.js';
import { createOrchestrationResumeService } from 'lib/orchestration-recovery.js';
import { projectOrchestrationStatus } from 'lib/orchestration-status.js';

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

function resumeHarness(lease, { last = null, unresolved = null, slot = null, linearIssue = issue(), portfolioReceipt = null } = {}) {
  const store = {
    async lastInvocation() { return last; },
    async unresolvedInvocation() { return unresolved; },
    async latestLease() { return lease; },
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

  results.push(await run('active lease after session loss returns recover_active_lease with its token', async () => {
    const lease = activeLease();
    const service = resumeHarness(lease, { slot: { lease_id: lease.lease_id, expires_at: lease.expires_at } });
    const packet = await service.resume({ run_id: 'run-1' });
    assert(packet.continuation === 'recover_active_lease', `unexpected continuation ${packet.continuation}`);
    assert(packet.active_execution.lease_token === 'wlt_SECRET_TOKEN', 'owned active lease token missing from recovery packet');
    assert(packet.historical_correlation_missing === true, 'pre-journal lease did not report missing correlation history');
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

  const failed = results.filter((result) => !result.ok);
  return { ok: failed.length === 0, passed: results.length - failed.length, failed: failed.length, tests: results };
}