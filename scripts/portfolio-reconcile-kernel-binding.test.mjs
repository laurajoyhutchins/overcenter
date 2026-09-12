import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('../', import.meta.url);

test('portfolio reconciliation is executed through the canonical transaction kernel', async () => {
  const api = await readFile(new URL('api/portfolio-reconcile-work-surface.js', repoRoot), 'utf8');
  const runtime = await readFile(new URL('lib/portfolio-reconcile-execution-runtime.js', repoRoot), 'utf8');

  assert.match(api, /portfolio-reconcile-execution-runtime/);
  assert.doesNotMatch(api, /compact-portfolio-reconcile-runtime/);
  assert.match(runtime, /executePortfolioReconciliation/);
  assert.match(runtime, /executionTransactionStore/);
  assert.match(runtime, /reconcilePortfolioWorkSurface/);
});
