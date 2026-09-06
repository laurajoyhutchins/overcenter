import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

const LEASE='11111111-1111-4111-8111-111111111111';

test('mechanical coalescing is a lease-scoped canonical worker recovery command', () => {
  const descriptor=semanticCommandDescriptor('github.coalesce_mechanical_changeset');
  assert.equal(descriptor.exposure.worker,true);
  assert.deepEqual(descriptor.required_fields,['lease_ref','changes','commit_message']);
  for(const forbidden of ['repo','branch','base_ref','base_sha','expected_head','idempotency_key','lease_token']) {
    assert.equal(descriptor.semantic_fields.includes(forbidden),false,`caller owns ${forbidden}`);
  }
  assert.ok(CANONICAL_COMMANDS.includes('github.coalesce_mechanical_changeset'));
  assert.equal(descriptor.input_schema.additionalProperties,false);
});

test('ordinary changeset recovery advertises the executable coalescing command', async () => {
  const source=await import('../lib/github-apply-changeset.js');
  assert.equal(typeof source.githubMechanicalCoalescingRecovery,'function');
  assert.deepEqual(source.githubMechanicalCoalescingRecovery({parent_head:'a'.repeat(40)}),{
    command:'github.coalesce_mechanical_changeset',
    required_fields:['lease_ref','changes','commit_message'],
    parent_head:'a'.repeat(40),
  });
});