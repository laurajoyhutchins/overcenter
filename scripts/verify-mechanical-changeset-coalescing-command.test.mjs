import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

test('mechanical changeset rejection exposes a canonical lease-scoped coalescing command', () => {
  assert.ok(CANONICAL_COMMANDS.includes('github.coalesce_mechanical_changeset'));
  const descriptor = semanticCommandDescriptor('github.coalesce_mechanical_changeset');
  assert.equal(descriptor.exposure.worker, true);
  assert.deepEqual(descriptor.required_fields, ['lease_ref', 'changes', 'commit_message']);
  for (const field of ['repo', 'branch', 'base_ref', 'base_sha', 'expected_head', 'idempotency_key', 'lease_token']) {
    assert.ok(!descriptor.semantic_fields.includes(field), `caller must not own ${field}`);
  }
});
