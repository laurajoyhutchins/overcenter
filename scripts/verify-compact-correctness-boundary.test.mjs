import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPostgresOrchestrationJournal, executeCorrelatedCommand } from '../lib/orchestration-journal.js';

const root = new URL('../', import.meta.url);
const correctnessModules = [
  'lib/orchestration-recovery.js',
  'lib/orchestration-finish-runtime.js',
  'lib/project-transition-leases.js',
  'lib/github-production-promotion-runtime.js',
  'lib/compact-github-changeset-receipt-store.js',
  'lib/compact-github-release-receipt-store.js',
  'lib/compact-github-production-promotion-receipt-store.js',
  'lib/compact-portfolio-reconcile-receipt-store.js',
];

const forbiddenHistory = [
  'orchestration_command_invocations',
  'orchestration_invocation_resolutions',
  'orchestration_horizons',
  'work_lease_checkpoints',
  'work_lease_heartbeats',
  'portfolio_reconcile_receipts',
  'portfolio_verification_receipts',
  'github_changeset_receipts',
  'github_release_receipts',
  'github_production_promotion_receipts',
];

test('execution correctness never reads historical telemetry or retired receipt ledgers', async () => {
  for (const file of correctnessModules) {
    const source = await readFile(new URL(file, root), 'utf8');
    for (const table of forbiddenHistory) {
      assert.ok(!source.includes(table), `${file} still depends on historical correctness state: ${table}`);
    }
  }
});

test('successful journaled commands do not issue a second current-failure write', async () => {
  let currentFailureWrites = 0;
  let finishes = 0;
  const journal = {
    async start() { return { invocation_id: 'inv-1', sequence: 7 }; },
    async finish() { finishes += 1; },
  };
  const currentFailureStore = {
    async record() { currentFailureWrites += 1; },
  };

  const response = await executeCorrelatedCommand(
    'work.settle',
    { run_id: 'run-1', disposition: 'completed' },
    async () => ({ ok: true }),
    { journal, currentFailureStore },
  );

  assert.equal(response.body.ok, true);
  assert.equal(finishes, 1);
  assert.equal(currentFailureWrites, 0);
});

test('journal finish folds matching current-failure clearing into the durable run update', async () => {
  const calls = [];
  const dbBinding = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const journal = createPostgresOrchestrationJournal(dbBinding);

  await journal.finish(
    'inv-1',
    { ok: true, command: 'work.settle' },
    { run_id: 'run-1', command: 'work.settle', sequence: 9 },
  );

  assert.equal(calls.length, 2, 'finish should write the invocation and run exactly once each');
  const runUpdate = calls[1];
  assert.match(runUpdate.sql, /current_failure_command = CASE WHEN finish\.succeeded/);
  assert.match(runUpdate.sql, /run\.current_failure_command = finish\.command/);
  assert.match(runUpdate.sql, /run\.current_failure_command = 'work\.heartbeat' AND finish\.command = 'work\.settle'/);
  assert.match(runUpdate.sql, /current_failure_streak = CASE[\s\S]*THEN 0 ELSE run\.current_failure_streak END/);
  assert.deepEqual(runUpdate.params.slice(3), [true, 'work.settle']);
});

test('failed commands still record current failure separately', async () => {
  let currentFailureWrites = 0;
  const journal = {
    async start() { return { invocation_id: 'inv-2', sequence: 8 }; },
    async finish() {},
  };
  const currentFailureStore = {
    async record() { currentFailureWrites += 1; },
  };

  const response = await executeCorrelatedCommand(
    'work.settle',
    { run_id: 'run-2', disposition: 'completed' },
    async () => { const error = new Error('boom'); error.code = 'TEST_FAILURE'; throw error; },
    { journal, currentFailureStore },
  );

  assert.equal(response.body.ok, false);
  assert.equal(currentFailureWrites, 1);
});
