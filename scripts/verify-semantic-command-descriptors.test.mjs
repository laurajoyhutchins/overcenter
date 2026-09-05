import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import './verify-release-publish.test.mjs';
import { CANONICAL_COMMANDS } from '../lib/canonical-commands.js';
import {
  MIGRATED_SEMANTIC_COMMANDS,
  semanticCommandDescriptor,
} from '../lib/semantic-command-descriptors.js';
import { renderSemanticCommandReference } from './render-semantic-command-reference.mjs';

const expected = ['github.apply_changeset', 'github.apply_text_replacements', 'github.pull_request.mark_ready', 'github.release.create', 'orchestration.diagnose', 'production.reconcile', 'production.promote', 'project.advance', 'project.amend', 'project.define', 'project.inspect', 'release.publish', 'work.settle'];
const expectedSurface = new Map([
  ['github.apply_changeset', 'advanced'],
  ['github.apply_text_replacements', 'advanced'],
  ['github.pull_request.mark_ready', 'advanced'],
  ['github.release.create', 'advanced'],
  ['orchestration.diagnose', 'operator'],
  ['production.reconcile', 'primary'],
  ['production.promote', 'primary'],
  ['project.advance', 'primary'],
  ['project.amend', 'primary'],
  ['project.define', 'primary'],
  ['project.inspect', 'primary'],
  ['release.publish', 'primary'],
  ['work.settle', 'compatibility'],
]);
const expectedExposure = new Map([
  ['github.apply_changeset', { worker:true, mcp:false }],
  ['github.apply_text_replacements', { worker:true, mcp:false }],
  ['github.pull_request.mark_ready', { worker:true, mcp:false }],
  ['github.release.create', { worker:true, mcp:false }],
  ['orchestration.diagnose', { worker:true, mcp:false }],
  ['work.settle', { worker:true, mcp:false }],
]);
const primaryMcpFiles = ['production.reconcile.js', 'production.promote.js', 'project.advance.js', 'project.amend.js', 'project.define.js', 'project.inspect.js', 'release.publish.js'];

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
    assert.deepEqual(descriptor.exposure, expectedExposure.get(command) || { worker:true, mcp:true });
    assert.equal(descriptor.surface, expectedSurface.get(command), `${command} must declare its agent-facing exposure class`);
    assert.ok(descriptor.mcp_name.length > 0);
  }
});

test('primary semantic surface is mechanically identifiable from descriptors', () => {
  const primary = expected.filter((command) => semanticCommandDescriptor(command).surface === 'primary');
  assert.deepEqual(primary, ['production.reconcile', 'production.promote', 'project.advance', 'project.amend', 'project.define', 'project.inspect', 'release.publish']);
});

test('top-level MCP discovery exposes only the primary semantic product surface', async () => {
  const entries = await readdir(new URL('../mcp/', import.meta.url), { withFileTypes:true });
  const registered = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.js')).map((entry) => entry.name).sort();
  assert.deepEqual(registered, [...primaryMcpFiles].sort());
});

test('every worker-exposed primary semantic command is admitted canonically', () => {
  const admitted = new Set(CANONICAL_COMMANDS);
  const primaryWorkerCommands = expected.filter((command) => {
    const descriptor = semanticCommandDescriptor(command);
    return descriptor.surface === 'primary' && descriptor.exposure.worker;
  });
  for (const command of primaryWorkerCommands) assert.ok(admitted.has(command), `${command} is worker-exposed primary intent but is not canonically admitted`);
});

test('production reconciliation exposes repo intent without mechanical coordinates', () => {
  const descriptor = semanticCommandDescriptor('production.reconcile');
  assert.equal(descriptor.surface, 'primary');
  assert.deepEqual(descriptor.semantic_fields, ['repo']);
  assert.deepEqual(descriptor.required_fields, ['repo']);
  assert.deepEqual(descriptor.exposure, { worker:true, mcp:true });
  for (const field of ['candidate_sha','verification_run_id','production_branch','runtime_ref','idempotency_key']) {
    assert.equal(descriptor.semantic_fields.includes(field), false, `${field} leaked through production.reconcile intent`);
  }
});

test('production promotion intent is exposed after its runtime host exists', () => {
  const descriptor = semanticCommandDescriptor('production.promote');
  assert.equal(descriptor.surface, 'primary');
  assert.deepEqual(descriptor.semantic_fields, ['repo']);
  assert.deepEqual(descriptor.required_fields, ['repo']);
  assert.deepEqual(descriptor.exposure, { worker:true, mcp:true });
});

test('project advance intent exposes judgment completion without run choreography', () => {
  const descriptor = semanticCommandDescriptor('project.advance');
  assert.equal(descriptor.surface, 'primary');
  assert.deepEqual(descriptor.semantic_fields, ['project_ref', 'transition_id', 'resume_ref', 'execution_result']);
  assert.deepEqual(descriptor.required_fields, ['project_ref']);
  assert.deepEqual(descriptor.exposure, { worker:true, mcp:true });
});

test('project inspect intent is exposed after its host adapter is production-routed', () => {
  const descriptor = semanticCommandDescriptor('project.inspect');
  assert.equal(descriptor.surface, 'primary');
  assert.deepEqual(descriptor.semantic_fields, ['project_ref']);
  assert.deepEqual(descriptor.required_fields, ['project_ref']);
  assert.deepEqual(descriptor.exposure, { worker:true, mcp:true });
});

test('release publish intent consumes a plan without exposing GitHub release bookkeeping', () => {
  const descriptor = semanticCommandDescriptor('release.publish');
  assert.equal(descriptor.surface, 'primary');
  assert.deepEqual(descriptor.semantic_fields, ['plan', 'body']);
  assert.deepEqual(descriptor.required_fields, ['plan', 'body']);
  assert.deepEqual(descriptor.exposure, { worker:true, mcp:true });
  const mechanical = ['repo','target_sha','tag_name','name','draft','prerelease','expected_state','idempotency_key','run_id'];
  for (const field of mechanical) assert.equal(descriptor.semantic_fields.includes(field), false, `${field} leaked through release.publish intent`);
});

test('migrated worker validation remains descriptor-derived for worker capabilities', async () => {
  const worker = await source('lib/worker-transport.js');
  for (const command of expected.filter((command) => semanticCommandDescriptor(command).exposure.worker)) {
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

test('release publish primary MCP transport derives from descriptor and host adapter', async () => {
  const text = await source('mcp/release.publish.js');
  assert.match(text, /semanticCommandDescriptor\(['"]release\.publish['"]\)/);
  assert.match(text, /releasePublishingFor/);
  assert.match(text, /executeCorrelatedCommand/);
  assert.match(text, /\.publish\(input\)/);
});

test('primary MCP metadata stays statically parseable and mechanically matches descriptors', async () => {
  const adapters = [
    ['project.define','mcp/project.define.js','PROJECT_DEFINE_INPUT_SCHEMA'],
    ['project.amend','mcp/project.amend.js','PROJECT_AMEND_INPUT_SCHEMA'],
  ];
  for (const [command,path,schemaName] of adapters) {
    const descriptor = semanticCommandDescriptor(command);
    const text = await source(path);
    assert.equal(literalProperty(text, 'name'), descriptor.mcp_name, `${command} MCP name drifted`);
    assert.equal(literalProperty(text, 'description'), descriptor.description, `${command} MCP description drifted`);
    assert.match(text, new RegExp(`inputSchema\\s*:\\s*${schemaName}`));
  }
});

test('semantic schema compatibility projections derive from the authoritative descriptor', async () => {
  const projections = [
    ['work.settle','lib/work-settle-contract.js'],
    ['github.release.create','lib/github-release-contract.js'],
    ['orchestration.diagnose','lib/orchestration-diagnose-contract.js'],
    ['project.define','lib/project-authoring-mcp-contract.js'],
    ['project.amend','lib/project-authoring-mcp-contract.js'],
  ];
  for (const [command,path] of projections) {
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