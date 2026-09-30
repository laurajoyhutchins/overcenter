import { execFileSync } from 'node:child_process';
import { GitOvercenterKernel } from '../src/storage/git-kernel.ts';
import { GitFactStore } from '../src/storage/git-store.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OvercenterKernel } from '../src/authority/kernel.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import {
  validateSourceTransactionBindingFact,
  sourceTransactionPlanDigest,
  validateSourceTransactionPlan,
  type SourceTransactionPlan,
} from '../src/source/transaction.ts';

function plan(): SourceTransactionPlan {
  return {
    schema: 'overcenter-source-transaction',
    schema_version: 1,
    repository_id: 42,
    repository_full_name: 'acme/widget',
    runtime_sha: 'a'.repeat(40),
    claim: {
      obligation_key: 'key',
      run_id: 'run',
      claimed_revision: 'revision',
      source_sha: 'b'.repeat(40),
    },
    execution_generation: 1,
    execution_authority_commit: 'authority',
    candidate_sha: 'c'.repeat(40),
    candidate_tree: 'd'.repeat(40),
    authorized_write_set: ['value.ts', 'extra.ts'],
    expected_write_set: ['value.ts'],
    observed_write_set: ['value.ts'],
    assurance: {
      base_revision: 'b'.repeat(40),
      candidate_revision: 'c'.repeat(40),
      candidate_tree: 'd'.repeat(40),
      model_sha256: 'e'.repeat(64),
      dependency_sha256: 'f'.repeat(64),
      baseline_id: 'repository-baseline',
      baseline_sha256: '1'.repeat(64),
      coverage_gaps: [{ artifact_id: 'value.ts', reason: 'unmodeled-artifact' }],
      validation_mode: 'baseline',
      changed_artifacts: ['value.ts'],
      impacts: [],
      proof_plans: [],
      evidence: [],
    },
  };
}

test('transaction plans reject missing and extra writes before authority binding', () => {
  assert.throws(
    () => validateSourceTransactionPlan({ ...plan(), observed_write_set: [] }),
    /SOURCE_TRANSACTION_DIVERGED/,
  );
  assert.throws(
    () =>
      validateSourceTransactionPlan({ ...plan(), observed_write_set: ['value.ts', 'extra.ts'] }),
    /SOURCE_TRANSACTION_DIVERGED/,
  );
  assert.throws(
    () =>
      validateSourceTransactionPlan({
        ...plan(),
        expected_write_set: ['outside.ts'],
        observed_write_set: ['outside.ts'],
      }),
    /SOURCE_TRANSACTION_SCOPE/,
  );
  assert.throws(
    () => validateSourceTransactionPlan({ ...plan(), unexpected: true }),
    /SOURCE_TRANSACTION_INVALID/,
  );
});

test('transaction identity covers repository, candidate and baseline authority', () => {
  const original = sourceTransactionPlanDigest(plan());
  assert.notEqual(sourceTransactionPlanDigest({ ...plan(), repository_id: 43 }), original);
  assert.notEqual(
    sourceTransactionPlanDigest({
      ...plan(),
      assurance: { ...plan().assurance, baseline_sha256: '2'.repeat(64) },
    }),
    original,
  );
});

test('source transaction bindings survive reconstruction and reject stale permits', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-transaction-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'state.db');
  const kernel = new OvercenterKernel(path);
  kernel.initialize();
  kernel.define({
    id: 'source',
    packet: {
      schema: 'overcenter-source-task',
      schema_version: 2,
      kind: 'source-change',
      objective: 'Update value',
      writable_paths: ['value.ts', 'extra.ts'],
      expected_write_set: ['value.ts'],
      effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
    },
    postcondition: { verifier: 'source-integration/v1' },
  });
  const claimed = kernel.claim('source', kernel.head()!, { sourceRevision: 'b'.repeat(40) });
  const permit = kernel.acquireExecution(claimed.id);
  const value = {
    ...plan(),
    claim: kernel.sourceClaimBinding(claimed.id),
    execution_generation: permit.execution_generation,
    execution_authority_commit: permit.execution_authority_commit,
  };
  const commit = kernel.bindSourceTransaction(permit, value);
  assert.ok(commit);
  const expected = kernel.sourceTransaction(claimed.id);
  assert.equal(expected?.plan_digest, sourceTransactionPlanDigest(value));
  kernel.acquireExecution(claimed.id);
  assert.throws(() => kernel.bindSourceTransaction(permit, value), /STALE_EXECUTION_GENERATION/);
  kernel.close();
  const replayed = new OvercenterKernel(path);
  assert.deepEqual(replayed.sourceTransaction(claimed.id), expected);
  replayed.close();
});

test('Git authority reconstruction retains exact binding and rejects tampered plan references', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-git-transaction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--bare', root], { stdio: 'ignore' });
  const kernel = new GitOvercenterKernel(root);
  kernel.initialize();
  kernel.define({
    id: 'source',
    packet: {
      schema: 'overcenter-source-task',
      schema_version: 2,
      kind: 'source-change',
      objective: 'Update value',
      writable_paths: ['value.ts', 'extra.ts'],
      expected_write_set: ['value.ts'],
      effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
    },
    postcondition: { verifier: 'source-integration/v1' },
  });
  const permit = kernel.claim('source', kernel.head()!, { sourceRevision: 'b'.repeat(40) });
  const value = {
    ...plan(),
    claim: kernel.sourceClaimBinding(permit.id),
    execution_generation: permit.execution_generation,
    execution_authority_commit: permit.execution_authority_commit,
  };
  assert.throws(
    () => kernel.bindSourceTransaction(permit, { ...value, authorized_write_set: ['value.ts'] }),
    /SOURCE_TRANSACTION_TASK_MISMATCH/,
  );
  kernel.bindSourceTransaction(permit, value);
  const expected = kernel.sourceTransaction(permit.id)!;
  assert.deepEqual(new GitOvercenterKernel(root).sourceTransaction(permit.id), expected);
  for (const corrupt of [
    { ...expected, plan_digest: '0'.repeat(64) },
    { ...expected, plan_ref: { ...expected.plan_ref, byte_length: 0 } },
    { ...expected, plan: null },
  ])
    assert.throws(() => validateSourceTransactionBindingFact(corrupt));
  const store = new GitFactStore(root, { ref: 'refs/overcenter/state' });
  store.append(kernel.head(), 'corrupt binding', {
    'source-transaction.json': { ...expected, plan_digest: '0'.repeat(64) },
  });
  assert.throws(
    () => new GitOvercenterKernel(root).sourceTransaction(permit.id),
    /SOURCE_TRANSACTION_INVALID/,
  );
});
