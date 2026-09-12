import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const repoRoot = new URL('../', import.meta.url);

test('GitHub changesets are executed through the canonical transaction kernel', async () => {
  const worker = await readFile(new URL('lib/github-worker-mutations.js', repoRoot), 'utf8');
  const branchRoles = await readFile(new URL('lib/github-branch-role-runtime.js', repoRoot), 'utf8');
  const changeset = await readFile(new URL('lib/github-apply-changeset.js', repoRoot), 'utf8');
  const transport = await readFile(new URL('lib/worker-transport.js', repoRoot), 'utf8');

  assert.match(worker, /executeGithubChangeset/);
  assert.match(worker, /executionTransactionStore/);
  assert.match(worker, /kernelManaged/);
  assert.match(branchRoles, /!options\.kernelManaged/);
  assert.match(changeset, /!options\.kernelManaged/);
  assert.match(transport, /executionTransactionStore:runtime\.executionTransactionStore/);
});

test('GitHub changeset effects have no provider-specific receipt ledger', async () => {
  const branchRoles = await readFile(new URL('lib/github-branch-role-runtime.js', repoRoot), 'utf8');
  const changeset = await readFile(new URL('lib/github-apply-changeset.js', repoRoot), 'utf8');

  assert.doesNotMatch(branchRoles, /createCompactGithubChangesetReceiptStore/);
  assert.doesNotMatch(changeset, /createGithubChangesetReceiptStore/);
  assert.doesNotMatch(changeset, /github_changeset_receipts/);
});


test('GitHub changeset provider effects allocate a distinct provider-operation lease', async () => {
  const worker = await readFile(new URL('lib/github-worker-mutations.js', repoRoot), 'utf8');
  const start = worker.indexOf('const transaction=await executeGithubChangeset');
  const end = worker.indexOf('providerFor()', start);
  const binding = worker.slice(start, end);
  assert.match(binding, /subject_kind:'provider_operation'/);
  assert.match(binding, /lease_epoch:Number\(shared\.lease_epoch\|\|epoch\|\|1\)/);
  assert.doesNotMatch(binding, /lease_ref:authority\.lease_ref/);
});
