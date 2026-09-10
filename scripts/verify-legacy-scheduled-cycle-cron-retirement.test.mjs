import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const legacyRoutes = [
  'api/scheduled-cycle/reconcile-dispatcher.js',
  'api/scheduled-cycle/reconcile-integration.js',
  'api/scheduled-cycle/reconcile-repository.js',
  'api/scheduled-cycle/reconcile-source.js',
  'api/scheduled-cycle/reconcile-verification.js',
];

test('legacy scheduled-cycle reconcilers are callable but not scheduled', async () => {
  for (const path of legacyRoutes) {
    const source = await readFile(new URL(path, root), 'utf8');
    assert.match(source, /export const access = 'scheduler';/u, `${path} remains callable through its existing scheduler-gated route`);
    assert.doesNotMatch(source, /export const schedule\s*=/u, `${path} must not declare a cron schedule`);
  }
});

test('graph-native orchestration maintenance is scheduled by the GCP control plane, not Hatchable', async () => {
  const legacySource = await readFile(new URL('api/orchestration/maintain-scheduled.js', root), 'utf8');
  const workflow = await readFile(new URL('.github/workflows/gcp-orchestration-maintain.yml', root), 'utf8');
  assert.doesNotMatch(legacySource, /export const schedule\s*=/u);
  assert.doesNotMatch(legacySource, /createPostgresSubjectAwareOrchestrationMaintenanceService/u);
  assert.match(legacySource, /HATCHABLE_MAINTENANCE_SCHEDULE_RETIRED/u);
  assert.match(workflow, /cron:\s*'17 \* \* \* \*'/u);
  assert.match(workflow, /orchestration\.maintain/u);
  assert.match(workflow, /x-overcenter-authority-mode: authoritative/u);
});