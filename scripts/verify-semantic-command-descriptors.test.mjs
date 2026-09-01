import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';
import {
  MIGRATED_SEMANTIC_COMMANDS,
  semanticCommandDescriptor,
} from '../lib/semantic-command-descriptors.js';
import { renderSemanticCommandReference } from './render-semantic-command-reference.mjs';

const expected = ['github.release.create', 'orchestration.diagnose', 'production.promote', 'project.advance', 'project.amend', 'project.define', 'project.inspect', 'work.settle'];
const expectedSurface = new Map([
  ['github.release.create', 'advanced'],
  ['orchestration.diagnose', 'operator'],
  ['production.promote', 'primary'],
  ['project.advance', 'primary'],
  ['project.amend', 'primary'],
  ['project.define', 'primary'],
  ['project.inspect', 'primary'],
  ['work.settle', 'compatibility'],
]);
const expectedExposure = new Map();

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

function literalProperty(text, property) {
  const match = text.match(new RegExp(`${property}\\s*:\\s*(['\"])(.*?)\\1`, 's'));
  assert.ok(match, `missing static ${property}`);
  return match[2];
}

test('representative commands have one authoritative semantic descriptor', () => {
  assert.deepEqual([...MIGRATED_SEMANTIC_COMMANDS].sort(), expected);

  for (const command of expected) {
    const descriptor = semanticCommandDescriptor(command);
    assert.equal(descriptor.command, command);
    assert.ok(descriptor.description.length > 20);
    assert.equal(descriptor.input_schema.type, 'object');
    assert.equal(descriptor.input_schema.additionalProperties, false);
    assert.deepEqual([...descriptor.semantic_fields].sort(), Object.keys(descriptor.input_schema.properties).sort(), `${command} semantic fields drifted from its schema`);
    assert.deepEqual([...descriptor.required_fields].sort(), [...(descriptor.input_schema.required || [])].sort(), `${command} required fields drifted from its schema`);
    assert.deepEqual(descriptor.exposure, expectedExposure.get(command) || { worker: true, mcp: true });
    assert.equal(descriptor.surface, expectedSurface.get(command), `${command} must declare its agent-facing exposure class`);
    assert.ok(descriptor.mcp_name.length > 0);
  }
});

test('primary semantic surface is mechanically identifiable from descriptors', () => {
  const primary = expected.filter((command) => semanticCommandDescriptor(command).surface === 'primary');
  assert.deepEqual(primary, ['production.promote', 'project.advance', 'project.amend', 'project.define', 'project.inspect']);
});

test('every worker-exposed primary semantic command is admitted canonically', () => {
  const admitted = new Set(CANONICAL_COMMANDS);
  const primaryWorkerCommands = expected.filter((command) => {
    const descriptor = semanticCommandDescriptor(command);
    return descriptor.surface === 'primary' && descriptor.exposure.worker;
  });
  for (const command of primaryWorkerCommands) {
    assert.ok(admitted.has(command), `${command} is worker-exposed primary intent but is not canonically admitted`);
  }
});

test('production promotion intent is exposed after its runtime host exists', () => {
  const descriptor = semanticCommandDescriptor('production.promote');
  assert.equal(descriptor.surface, 'primary');
  assert.deepEqual(descriptor.semantic_fields, ['repo']);
  assert.deepEqual(descriptor.required_fields, ['repo']);
  assert.deepEqual(descriptor.exposure, { worker: true, mcp: true });
});

test('project advance intent exposes session selection without run choreography', () => {
  const descriptor = semanticCommandDescriptor('project.advance');
  assert.equal(descriptor.surface, 'primary');
  assert.deepEqual(descriptor.semantic_fields, ['project_ref', 'transition_id', 'resume_ref']);
  assert.deepEqual(descriptor.required_fields, ['project_ref']);
  assert.deepEqual(descriptor.exposure, { worker: true, mcp: true });
});

test('project inspect intent is exposed after its host adapter is production-routed', () => {
  const descriptor = semanticCommandDescriptor('project.inspect');
  assert.equal(descriptor.surface, 'primary');
  assert.deepEqual(descriptor.semantic_fields, ['project_ref']);
  assert.deepEqual(descriptor.required_fields, ['project_ref']);
  assert.deepEqual(descriptor.exposure, { worker: true, mcp: true });
});

test('migrated worker validation is descriptor-derived rather than separately listed', async () => {
  const worker = await source('lib/worker-transport.js');
  for (const command of expected.filter((command) => semanticCommandDescriptor(command).exposure.worker && semanticCommandDescriptor(command).exposure.mcp)) {
    assert.match(worker, new RegExp(`semanticCommandDescriptor\\(['\"]${command.replaceAll('.', '\\.')}`));
  }
  assert.doesNotMatch(worker, /GITHUB_RELEASE_(?:SEMANTIC|REQUIRED)_FIELDS/);
  assert.doesNotMatch(worker, /WORK_SETTLE_(?:SEMANTIC|REQUIRED)_FIELDS/);
});

test('production promotion primary MCP transport derives from descriptor and runtime host', async () => {
  const text = await source('mcp/production.promote.js');
  assert.match(text, /semanticCommandDescriptor\(['"]production\.promote['"]\)/);
  assert.match(text, /productionPromotion/);
  assert.match(text, /executeCorrelatedCommand/);
  assert.match(text, /\.promote\(input\)/);
});

test('project inspect primary MCP transport derives from descriptor and host adapter', async () => {
  const text = await source('mcp/project.inspect.js');
  assert.match(text, /semanticCommandDescriptor\(['"]project\.inspect['"]\)/);
  assert.match(text, /projectInspectFor/);
  assert.match(text, /executeCorrelatedCommand/);
  assert.match(text, /\.inspect\(input\)/);
});

test('MCP metadata stays statically parseable and mechanically matches descriptors', async () => {
  const adapters = [
    ['work.settle', 'mcp/work.settle.js', 'WORK_SETTLE_INPUT_SCHEMA'],
    ['github.release.create', 'mcp/github_release_create.js', 'GITHUB_RELEASE_INPUT_SCHEMA'],
    ['orchestration.diagnose', 'mcp/orchestration.diagnose.js', 'ORCHESTRATION_DIAGNOSE_INPUT_SCHEMA'],
    ['project.define', 'mcp/project.define.js', 'PROJECT_DEFINE_INPUT_SCHEMA'],
    ['project.amend', 'mcp/project.amend.js', 'PROJECT_AMEND_INPUT_SCHEMA'],
  ];
  for (const [command, path, schemaName] of adapters) {
    const descriptor = semanticCommandDescriptor(command);
    const text = await source(path);
    assert.equal(literalProperty(text, 'name'), descriptor.mcp_name, `${command} MCP name drifted`);
    assert.equal(literalProperty(text, 'description'), descriptor.description, `${command} MCP description drifted`);
    assert.match(text, new RegExp(`inputSchema\\s*:\\s*${schemaName}`));
  }
});

test('MCP schema compatibility projections derive from the authoritative descriptor', async () => {
  const projections = [
    ['work.settle', 'lib/work-settle-contract.js'],
    ['github.release.create', 'lib/github-release-contract.js'],
    ['orchestration.diagnose', 'lib/orchestration-diagnose-contract.js'],
    ['project.define', 'lib/project-authoring-mcp-contract.js'],
    ['project.amend', 'lib/project-authoring-mcp-contract.js'],
  ];
  for (const [command, path] of projections) {
    const text = await source(path);
    assert.match(text, /semanticCommandDescriptor/);
    assert.match(text, new RegExp(`semanticCommandDescriptor\\(['\"]${command.replaceAll('.', '\\.')}`));
    assert.match(text, /\.input_schema/);
  }
});

test('generated command reference exactly matches descriptor source', async () => {
  assert.equal(await source('public/docs/semantic-command-descriptors.md'), renderSemanticCommandReference());
});

test('unknown command descriptors fail closed', () => {
  assert.throws(() => semanticCommandDescriptor('work.not-real'), /not migrated/);
});
