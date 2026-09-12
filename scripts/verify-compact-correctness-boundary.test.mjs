import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const correctnessModules = [
  'lib/orchestration-recovery.js',
  'lib/orchestration-finish-runtime.js',
  'lib/project-transition-leases.js',
  'lib/github-worker-mutations.js',
  'lib/github-branch-role-runtime.js',
  'lib/github-apply-changeset.js',
  'lib/production-promotion-overcenter-host.js',
  'lib/project-authoring-overcenter-host.js',
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

test('canonical provider entrypoints own effect correctness', async () => {
  const worker = await readFile(new URL('lib/github-worker-mutations.js', root), 'utf8');
  const promotion = await readFile(new URL('lib/production-promotion-overcenter-host.js', root), 'utf8');
  const authoring = await readFile(new URL('lib/project-authoring-overcenter-host.js', root), 'utf8');

  assert.match(worker, /executeBoundProviderEffect/);
  assert.match(promotion, /executeBoundProviderEffect/);
  assert.match(authoring, /executeBoundProviderEffect/);
});

test('successful journaled commands avoid a second current-failure database write', async () => {
  const source = await readFile(new URL('lib/orchestration-journal.js', root), 'utf8');
  assert.ok(source.includes('const journaled = Boolean(run_id && journal && invocation?.invocation_id);'));
  assert.ok(source.includes("!['orchestration.resume_packet','orchestration.diagnose'].includes(command) && (response.body?.ok !== true || !journaled)"));
  assert.ok(source.includes('await currentFailure.record(run_id, command, response.body);'));
  assert.ok(source.includes('if (journaled) {'));
  assert.ok(source.includes('await journal.finish(invocation.invocation_id, response.body, { run_id, command, sequence: invocation.sequence })'));
});

test('journal finish folds current-failure clearing into its existing durable run update', async () => {
  const source = await readFile(new URL('lib/orchestration-journal.js', root), 'utf8');
  assert.ok(source.includes('UPDATE orchestration_runs AS run SET'));
  assert.ok(source.includes('current_failure_command = CASE WHEN finish.succeeded'));
  assert.ok(source.includes('run.current_failure_command = finish.command'));
  assert.ok(source.includes("run.current_failure_command = 'work.heartbeat' AND finish.command = 'work.settle'"));
  assert.ok(source.includes('current_failure_error_code = CASE WHEN finish.succeeded'));
  assert.ok(source.includes('current_failure_error_class = CASE WHEN finish.succeeded'));
  assert.ok(source.includes('current_failure_retryable = CASE WHEN finish.succeeded'));
  assert.ok(source.includes('current_failure_rejection = CASE WHEN finish.succeeded'));
  assert.ok(source.includes('current_failure_may_have_mutated = CASE WHEN finish.succeeded'));
  assert.ok(source.includes('current_failure_streak = CASE WHEN finish.succeeded'));
  assert.ok(source.includes('THEN 0 ELSE run.current_failure_streak END'));
  assert.ok(source.includes('FROM (SELECT $4::boolean AS succeeded, $5::text AS command) AS finish'));
  assert.ok(source.includes('responseBody?.ok === true'));
  assert.ok(source.includes('activity.command'));
});

test('failed or unjournaled commands retain the separate current-failure recording path', async () => {
  const source = await readFile(new URL('lib/orchestration-journal.js', root), 'utf8');
  const condition = '(response.body?.ok !== true || !journaled)';
  const conditionIndex = source.indexOf(condition);
  const recordIndex = source.indexOf('await currentFailure.record(run_id, command, response.body);', conditionIndex);
  const finishIndex = source.indexOf('if (journaled) {', recordIndex);
  assert.ok(conditionIndex >= 0, 'failure/fallback condition is missing');
  assert.ok(recordIndex > conditionIndex, 'current-failure recording is not gated by failure or journal fallback');
  assert.ok(finishIndex > recordIndex, 'journal finish no longer follows failure recording fallback');
});
