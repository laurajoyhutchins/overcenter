import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MIGRATED_SEMANTIC_COMMANDS,
  semanticCommandDescriptor,
} from '../lib/semantic-command-descriptors.js';

const expected = ['github.release.create', 'orchestration.diagnose', 'work.settle'];

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('representative commands have one authoritative semantic descriptor', () => {
  assert.deepEqual([...MIGRATED_SEMANTIC_COMMANDS].sort(), expected);

  for (const command of expected) {
    const descriptor = semanticCommandDescriptor(command);
    assert.equal(descriptor.command, command);
    assert.ok(descriptor.description.length > 20);
    assert.equal(descriptor.input_schema.type, 'object');
    assert.equal(descriptor.input_schema.additionalProperties, false);
    assert.deepEqual(
      [...descriptor.semantic_fields].sort(),
      Object.keys(descriptor.input_schema.properties).sort(),
      `${command} semantic fields drifted from its schema`,
    );
    assert.deepEqual(
      [...descriptor.required_fields].sort(),
      [...(descriptor.input_schema.required || [])].sort(),
      `${command} required fields drifted from its schema`,
    );
    assert.equal(descriptor.exposure.worker, true);
    assert.equal(descriptor.exposure.mcp, true);
    assert.ok(descriptor.mcp_name.length > 0);
  }
});

test('migrated worker validation is descriptor-derived rather than separately listed', async () => {
  const worker = await source('lib/worker-transport.js');
  assert.match(worker, /semanticCommandDescriptor/);
  for (const command of expected) {
    assert.match(worker, new RegExp(`semanticCommandDescriptor\\(['\"]${command.replaceAll('.', '\\.')}`));
  }
  assert.doesNotMatch(worker, /GITHUB_RELEASE_(?:SEMANTIC|REQUIRED)_FIELDS/);
  assert.doesNotMatch(worker, /WORK_SETTLE_(?:SEMANTIC|REQUIRED)_FIELDS/);
});

test('representative MCP adapters consume descriptor schema and metadata', async () => {
  const adapters = [
    ['work.settle', 'mcp/work.settle.js'],
    ['github.release.create', 'mcp/github_release_create.js'],
    ['orchestration.diagnose', 'mcp/orchestration.diagnose.js'],
  ];

  for (const [command, path] of adapters) {
    const text = await source(path);
    assert.match(text, /semanticCommandDescriptor/);
    assert.match(text, new RegExp(`semanticCommandDescriptor\\(['\"]${command.replaceAll('.', '\\.')}`));
    assert.match(text, /inputSchema:\s*descriptor\.input_schema/);
    assert.match(text, /description:\s*descriptor\.description/);
    assert.match(text, /name:\s*descriptor\.mcp_name/);
  }
});

test('unknown command descriptors fail closed', () => {
  assert.throws(() => semanticCommandDescriptor('work.not-real'), /not migrated/);
});
