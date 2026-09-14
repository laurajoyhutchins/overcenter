import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createGithubIntegrationConvergenceService } from '../lib/github-integration-convergence.js';

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UPDATED_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MERGE_SHA = 'cccccccccccccccccccccccccccccccccccccccc';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function memoryOperations() {
  let row = null;
  const calls = [];
  const terminal = new Set(['succeeded', 'no_effect', 'rejected']);
  const publicRow = () => clone(row);
  return {
    calls,
    current: publicRow,
    async claim(input) {
      calls.push({ op:'claim', input:clone(input) });
      if (!row) {
        row = {
          operation_id:'operation-1', command:input.command, idempotency_scope:input.scope,
          idempotency_key:input.idempotency_key, request_sha256:input.request_sha256,
          state:'prepared', may_have_mutated:false,
          recovery_payload:{ ...clone(input.recovery_payload), attempt_token:input.attempt_token },
          resolution:null,
        };
        return { outcome:'claimed', recovered:false, operation:publicRow() };
      }
      if (row.request_sha256 !== input.request_sha256) return { outcome:'conflict', recovered:false, operation:publicRow() };
      if (terminal.has(row.state)) return { outcome:'terminal', recovered:false, operation:publicRow() };
      if (row.state === 'indeterminate') return { outcome:'indeterminate', recovered:false, operation:publicRow() };
      return { outcome:'in_progress', recovered:false, operation:publicRow() };
    },
    async claimPending(input) {
      calls.push({ op:'claimPending', input:clone(input) });
      if (!row || row.command !== input.command || row.idempotency_scope !== input.scope || row.idempotency_key !== input.idempotency_key) return null;
      if (row.request_sha256 !== input.request_sha256 || row.state !== 'prepared') return null;
      if (row.recovery_payload?.phase !== input.phase || row.recovery_payload?.attempt_token !== input.prior_attempt_token) return null;
      row.recovery_payload = { ...row.recovery_payload, attempt_token:input.attempt_token };
      return publicRow();
    },
    async updateRecovery(input) {
      calls.push({ op:'updateRecovery', input:clone(input) });
      row.recovery_payload = { ...clone(input.recovery_payload), attempt_token:input.attempt_token };
      return publicRow();
    },
    async markIndeterminate(input) {
      calls.push({ op:'markIndeterminate', input:clone(input) });
      row.state = 'indeterminate';
      row.may_have_mutated = true;
      row.recovery_payload = { ...clone(input.recovery_payload), attempt_token:input.attempt_token };
      return publicRow();
    },
    async succeed(input) {
      calls.push({ op:'succeed', input:clone(input) });
      row.state = 'succeeded';
      row.may_have_mutated = input.may_have_mutated !== false;
      row.recovery_payload = null;
      row.resolution = clone(input.resolution);
      return publicRow();
    },
    async reject(input) {
      calls.push({ op:'reject', input:clone(input) });
      row.state = 'rejected';
      row.may_have_mutated = Boolean(input.may_have_mutated);
      row.recovery_payload = null;
      row.resolution = clone(input.resolution);
      return publicRow();
    },
    async listPending(input) {
      calls.push({ op:'listPending', input:clone(input) });
      if (row?.state === 'prepared' && row.recovery_payload?.phase === input.phase) return [publicRow()];
      return [];
    },
  };
}

function pendingChecks() {
  return {
    ok:true,
    outcome:'waiting',
    waiting_on:['required_status_checks'],
    evidence:{ checks:{ pending_required:['verify'], failing_required:[] } },
  };
}

test('integration intent refreshes its own accepted head, waits, submits merge, and settles without caller continuation', async () => {
  const operations = memoryOperations();
  const observed = [];
  const responses = [
    { ok:true, outcome:'updated_for_recheck', head:{ sha:UPDATED_HEAD }, base:{ ref:'dev', sha:'dddddddddddddddddddddddddddddddddddddddd' } },
    pendingChecks(),
    { ok:true, outcome:'merge_submitted', merge_request_uuid:'merge-uuid' },
    { ok:true, outcome:'merged', merge_commit_sha:MERGE_SHA },
  ];
  const service = createGithubIntegrationConvergenceService({
    operations,
    uuid:() => `attempt-${observed.length + 1}`,
    reconcileIntegration:async (input) => {
      observed.push(clone(input));
      return responses.shift();
    },
  });

  const first = await service.converge({ repo:'owner/repo', pull_request:7, expected_head:HEAD });
  assert.equal(first.outcome, 'waiting');
  assert.equal(first.accepted_head, UPDATED_HEAD);
  assert.deepEqual(first.waiting_on, ['exact_head_verification']);
  assert.deepEqual(observed[0], { repo:'owner/repo', pull_request:7, expected_head:HEAD, apply:true });

  const [second] = await service.reconcilePending({ limit:20 });
  assert.equal(second.outcome, 'waiting');
  assert.deepEqual(second.waiting_on, ['required_status_checks']);
  assert.equal(observed[1].expected_head, UPDATED_HEAD);

  const [third] = await service.reconcilePending({ limit:20 });
  assert.equal(third.outcome, 'merge_pending');
  assert.equal(third.merge_request_uuid, 'merge-uuid');
  assert.equal(observed[2].expected_head, UPDATED_HEAD);

  const [fourth] = await service.reconcilePending({ limit:20 });
  assert.equal(fourth.outcome, 'merged');
  assert.equal(fourth.state, 'succeeded');
  assert.equal(fourth.merge_commit_sha, MERGE_SHA);
  assert.equal(observed[3].expected_head, UPDATED_HEAD);
  assert.equal(observed[3].merge_request_uuid, 'merge-uuid');
  assert.equal(observed[3].apply, true);

  const handoffs = operations.calls.filter((call) => call.op === 'claimPending');
  assert.equal(handoffs.length, 3);
  assert.equal(handoffs[0].input.prior_attempt_token, 'attempt-1');
  assert.equal(handoffs[0].input.attempt_token, 'attempt-2');
});

test('failed verification becomes requires_judgment instead of an automatic retry', async () => {
  const operations = memoryOperations();
  const service = createGithubIntegrationConvergenceService({
    operations,
    reconcileIntegration:async () => ({
      ok:true,
      outcome:'waiting',
      waiting_on:['required_status_checks'],
      evidence:{ checks:{ pending_required:[], failing_required:['verify'] } },
    }),
  });
  const result = await service.converge({ repo:'owner/repo', pull_request:8, expected_head:HEAD });
  assert.equal(result.outcome, 'requires_judgment');
  assert.equal(result.state, 'rejected');
  assert.deepEqual(result.waiting_on, ['verify']);
  assert.equal(operations.calls.at(-1).op, 'reject');
});

test('review objection, conflict, stacked rebase, policy ambiguity, and unexpected head movement are judgment boundaries', async () => {
  const cases = [
    { ok:true, outcome:'waiting', waiting_on:['changes_requested'], evidence:{ checks:{ failing_required:[] } } },
    { ok:false, error:'GITHUB_INTEGRATION_CONFLICT', message:'conflict' },
    { ok:true, outcome:'stack_rebase_required', stack:{ size:2 } },
    { ok:false, error:'GITHUB_INTEGRATION_POLICY_EVIDENCE_INCOMPLETE', message:'policy' },
    { ok:false, error:'GITHUB_INTEGRATION_RECOMPUTE_REQUIRED', observed_head:UPDATED_HEAD, message:'head moved' },
  ];
  for (const [index, response] of cases.entries()) {
    const operations = memoryOperations();
    const service = createGithubIntegrationConvergenceService({ operations, reconcileIntegration:async () => response });
    const result = await service.converge({ repo:'owner/repo', pull_request:20 + index, expected_head:HEAD });
    assert.equal(result.outcome, 'requires_judgment', `case ${index}: ${JSON.stringify(result)}`);
    assert.equal(result.state, 'rejected');
  }
});

test('uncertain mutation is parked indeterminate and never reissued blindly', async () => {
  const operations = memoryOperations();
  let calls = 0;
  const service = createGithubIntegrationConvergenceService({
    operations,
    reconcileIntegration:async () => {
      calls += 1;
      return { ok:false, error:'GITHUB_INTEGRATION_INDETERMINATE', may_have_mutated:true, message:'transport certainty lost' };
    },
  });
  const first = await service.converge({ repo:'owner/repo', pull_request:9, expected_head:HEAD });
  assert.equal(first.outcome, 'indeterminate');
  assert.equal(first.state, 'indeterminate');
  const replay = await service.converge({ repo:'owner/repo', pull_request:9, expected_head:HEAD });
  assert.equal(replay.outcome, 'indeterminate');
  assert.equal(calls, 1);
});

test('compact operation store exposes token-fenced terminal rejection and pending handoff paths', async () => {
  const source = await readFile(new URL('../lib/compact-provider-operation-store.js', import.meta.url), 'utf8');
  assert.match(source, /async function reject\(input = \{\}\)/);
  assert.match(source, /SET state='rejected'/);
  assert.match(source, /recovery_payload->>'attempt_token'=\$4/);
  assert.match(source, /async function claimPending\(input = \{\}\)/);
  assert.match(source, /recovery_payload->>'phase'=\$8/);
  assert.match(source, /recovery_payload->>'attempt_token'=\$5/);
  assert.match(source, /return Object\.freeze\(\{[^}]*claimPending[^}]*reject/s);
});

test('orchestration maintenance owns pending integration convergence without selecting semantic work', async () => {
  const source = await readFile(new URL('../lib/orchestration-maintenance-subjects.js', import.meta.url), 'utf8');
  assert.match(source, /createGithubIntegrationConvergenceForRuntime/);
  assert.match(source, /kind:'github_integration'/);
  assert.match(source, /createGithubIntegrationConvergenceForRuntime\(\{/);
  assert.match(source, /\.reconcilePending\(request\)/);
});
