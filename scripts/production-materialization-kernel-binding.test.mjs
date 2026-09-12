import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('../', import.meta.url);

test('production materialization is executed through the canonical transaction kernel', async () => {
  const host = await readFile(new URL('lib/production-reconcile-overcenter-host.js', repoRoot), 'utf8');

  assert.match(host, /executeProductionMaterialization/);
  assert.match(host, /executionTransactionStore/);
  assert.match(host, /materializationWithKernel/);
  assert.match(host, /reconcileRuntime:\(repo,selectedRevision,roles\)=>materializationWithKernel/);
});
