import test from 'node:test';
import assert from 'node:assert/strict';

import {
  semanticCommandDescriptor,
  semanticMcpDiscoveryForSurface,
} from '../lib/semantic-command-descriptors.js';

test('project.advance is discoverable as a compact primary MCP operation', () => {
  const descriptor = semanticCommandDescriptor('project.advance');
  assert.equal(descriptor.surface, 'primary');
  assert.equal(descriptor.exposure.mcp, true);
  assert.deepEqual(descriptor.required_fields, ['project_ref']);
  assert.deepEqual(descriptor.semantic_fields, ['project_ref']);

  const discovered = semanticMcpDiscoveryForSurface('primary');
  const projectAdvance = discovered.find((entry) => entry.command === 'project.advance');
  assert.ok(projectAdvance);
  assert.equal(projectAdvance.name, 'project.advance');
  assert.deepEqual(projectAdvance.input_schema.required, ['project_ref']);
  assert.deepEqual(Object.keys(projectAdvance.input_schema.properties), ['project_ref']);
  assert.equal(projectAdvance.input_schema.additionalProperties, false);
});