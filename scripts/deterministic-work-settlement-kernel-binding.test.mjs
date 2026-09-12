import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('../', import.meta.url);

test('deterministic work settlement is bounded by the execution transaction kernel', async () => {
  const runtime = await readFile(new URL('lib/deterministic-work-settlement-execution-runtime.js', repoRoot), 'utf8');
  const primitive = await readFile(new URL('lib/deterministic-work-settlement.js', repoRoot), 'utf8');

  assert.match(runtime, /executeDeterministicWorkSettlement/);
  assert.match(runtime, /executionTransactionStore/);
  assert.match(runtime, /confirm/);
  assert.doesNotMatch(runtime, /createPostgresVerificationReceiptStore/);
  assert.match(primitive, /export async function evaluateDeterministicWorkPredicate/);
});
