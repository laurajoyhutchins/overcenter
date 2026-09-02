import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
