import test from 'node:test';
import assert from 'node:assert/strict';
import { semanticCommandDescriptor } from '../lib/semantic-command-descriptors.js';

test('project.artifact.bind is a published primary semantic command with explicit binding fields', () => {
  const descriptor = semanticCommandDescriptor('project.artifact.bind');
  assert.equal(descriptor.command, 'project.artifact.bind');
  assert.equal(descriptor.surface, 'primary');
  assert.deepEqual(descriptor.required_fields, [
    'project_ref',
    'expected_revision',
    'transition_id',
    'provider',
    'relationship',
    'satisfaction_condition',
  ]);
  assert.equal(descriptor.exposure.worker, true);
  assert.equal(descriptor.exposure.mcp, true);
});
