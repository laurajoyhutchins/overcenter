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

test('graph-native orchestration maintenance remains scheduled', async () => {
  const source = await readFile(new URL('api/orchestration/maintain-scheduled.js', root), 'utf8');
  assert.match(source, /export const schedule\s*=\s*'17 \* \* \* \*';/u);
});