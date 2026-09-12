import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveProjectTransitionGithubWorkspace,
  projectTransitionGithubChangesetIdempotencyKey,
} from './project-transition-github-workspace.js';

const authority = Object.freeze({
  subject:'project_transition',
  lease_ref:'11111111-1111-4111-8111-111111111111',
  lease_id:'11111111-1111-4111-8111-111111111111',
  run_id:'run-1',
  authority_epoch:1,
  repository:'laurajoyhutchins/overcenter',
  project_ref:'github:laurajoyhutchins/overcenter',
  transition_id:'ignore-stale-historical-project-transition-leases',
  authority:{kind:'github',repository:'laurajoyhutchins/overcenter',revision:'1'.repeat(40),derivation:'overcenter-project-graph-v1'},
  graph_fingerprint:'a'.repeat(64),
  transition_definition_fingerprint:'b'.repeat(64),
});

test('workspace generation is deterministic and lease-independent', async () => {
  const first = await deriveProjectTransitionGithubWorkspace(authority);
  const replay = await deriveProjectTransitionGithubWorkspace(authority);
  const reacquired = await deriveProjectTransitionGithubWorkspace({
    ...authority,
    lease_ref:'22222222-2222-4222-8222-222222222222',
    lease_id:'22222222-2222-4222-8222-222222222222',
  });
  assert.equal(first.workspace_digest, replay.workspace_digest, 'workspace replay drifted');
  assert.equal(first.branch, replay.branch, 'workspace replay branch drifted');
  assert.equal(first.workspace_digest, reacquired.workspace_digest, 'lease identity leaked into workspace generation');
  assert.equal(first.branch, reacquired.branch, 'lease identity leaked into workspace branch');
  assert.match(first.branch, /^work\/[a-z0-9-]+-[0-9a-f]{24}$/, 'managed branch shape is invalid');
});

test('authority revision and transition definition fingerprint select new generations', async () => {
  const base = await deriveProjectTransitionGithubWorkspace(authority);
  const revision = await deriveProjectTransitionGithubWorkspace({ ...authority, authority:{ ...authority.authority, revision:'2'.repeat(40) } });
  const definition = await deriveProjectTransitionGithubWorkspace({ ...authority, transition_definition_fingerprint:'c'.repeat(64) });
  assert.notEqual(base.workspace_digest, revision.workspace_digest, 'authority revision reused workspace generation');
  assert.notEqual(base.branch, revision.branch, 'authority revision reused workspace branch');
  assert.notEqual(base.workspace_digest, definition.workspace_digest, 'transition definition reused workspace generation');
  assert.notEqual(base.branch, definition.branch, 'transition definition reused workspace branch');
});

test('workspace derivation rejects malformed or non-GitHub authority', async () => {
  for (const invalid of [
    { ...authority, subject:'legacy_work' },
    { ...authority, authority:null },
    { ...authority, authority:{kind:'gitlab',repository:authority.repository,revision:'1'.repeat(40)} },
    { ...authority, authority:{kind:'github',repository:authority.repository,revision:'moving-ref'} },
  ]) {
    await assert.rejects(deriveProjectTransitionGithubWorkspace(invalid), undefined, 'invalid authority was accepted');
  }
});

test('changeset idempotency binds lease and observed workspace head', async () => {
  const workspace = await deriveProjectTransitionGithubWorkspace(authority);
  const input = { lease_ref:authority.lease_ref, workspace_digest:workspace.workspace_digest, observed_head:null, changeset_sha256:'d'.repeat(64) };
  const first = await projectTransitionGithubChangesetIdempotencyKey(input);
  const replay = await projectTransitionGithubChangesetIdempotencyKey(input);
  const newLease = await projectTransitionGithubChangesetIdempotencyKey({ ...input, lease_ref:'22222222-2222-4222-8222-222222222222' });
  const advanced = await projectTransitionGithubChangesetIdempotencyKey({ ...input, observed_head:'3'.repeat(40) });
  assert.equal(first, replay, 'exact idempotency replay drifted');
  assert.notEqual(first, newLease, 'reacquisition reused prior lease idempotency scope');
  assert.notEqual(first, advanced, 'advanced workspace head reused prior mutation identity');
  assert.match(first, /^project-transition-changeset-v1:[0-9a-f]{64}$/, 'idempotency key shape is invalid');
});
