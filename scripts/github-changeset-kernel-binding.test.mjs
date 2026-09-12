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

test('the old changeset receipt ledger is not selected for kernel-managed effects', async () => {
  const branchRoles = await readFile(new URL('lib/github-branch-role-runtime.js', repoRoot), 'utf8');
  const changeset = await readFile(new URL('lib/github-apply-changeset.js', repoRoot), 'utf8');

  assert.match(branchRoles, /createCompactGithubChangesetReceiptStore/);
  assert.match(branchRoles, /kernelManaged/);
  assert.match(changeset, /createGithubChangesetReceiptStore/);
  assert.match(changeset, /kernelManaged/);
});
