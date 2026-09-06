import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresOrchestrationJournal } from '../lib/orchestration-journal.js';

function row(overrides = {}) {
  return {
    invocation_id: '11111111-1111-4111-8111-111111111111',
    run_id: 'run-1',
    command: 'github.review_packet',
    request_sha256: 'a'.repeat(64),
    request_projection: { repo: 'owner/repo' },
    target_kind: 'github_repository',
    target_ref: 'owner/repo',
    outcome: 'running',
    result_sha256: null,
    result_projection: null,
    error_code: null,
    may_have_mutated: false,
    started_at: '2026-09-06T01:00:00.000Z',
    completed_at: null,
    ...overrides,
  };
}

function fakeDb(invocation) {
  return {
    async query(sql, values) {
      if (!sql.includes('FROM orchestration_command_invocations')) throw new Error(`unexpected SQL: ${sql}`);
      if (values?.[0] !== invocation.invocation_id) return { rows: [] };
      return { rows: [invocation] };
    },
  };
}

test('peek returns bounded authoritative active invocation state', async () => {
  const invocation = row();
  const journal = createPostgresOrchestrationJournal(fakeDb(invocation));
  const observed = await journal.peek({ invocation_id: invocation.invocation_id });
  assert.equal(observed.invocation_id, invocation.invocation_id);
  assert.equal(observed.state, 'active');
  assert.equal(observed.command, invocation.command);
  assert.equal(observed.result, null);
});

test('attach reconnects to the same active invocation for an exact semantic identity', async () => {
  const invocation = row();
  const journal = createPostgresOrchestrationJournal(fakeDb(invocation));
  const attached = await journal.attach({
    invocation_id: invocation.invocation_id,
    command: invocation.command,
    request_sha256: invocation.request_sha256,
  });
  assert.equal(attached.invocation_id, invocation.invocation_id);
  assert.equal(attached.state, 'active');
  assert.equal(attached.reconnected, true);
});

test('attach returns the same completed result without creating parallel execution identity', async () => {
  const invocation = row({
    outcome: 'succeeded',
    result_sha256: 'b'.repeat(64),
    result_projection: { repo: 'owner/repo', head_sha: 'c'.repeat(40) },
    completed_at: '2026-09-06T01:01:00.000Z',
  });
  const journal = createPostgresOrchestrationJournal(fakeDb(invocation));
  const attached = await journal.attach({
    invocation_id: invocation.invocation_id,
    command: invocation.command,
    request_sha256: invocation.request_sha256,
  });
  assert.equal(attached.state, 'completed');
  assert.deepEqual(attached.result, invocation.result_projection);
  assert.equal(attached.result_sha256, invocation.result_sha256);
});

test('attach fails closed when invocation identity is reused for inconsistent command authority', async () => {
  const invocation = row();
  const journal = createPostgresOrchestrationJournal(fakeDb(invocation));
  await assert.rejects(
    journal.attach({
      invocation_id: invocation.invocation_id,
      command: 'github.apply_changeset',
      request_sha256: invocation.request_sha256,
    }),
    (error) => error?.code === 'INVOCATION_AUTHORITY_MISMATCH' && error?.may_have_mutated === false,
  );
});