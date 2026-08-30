import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { semanticCommandDescriptorsForSurface } from '../lib/semantic-command-descriptors.js';
import { renderPrimarySemanticSurface } from './render-primary-semantic-surface.mjs';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('primary agent surface contains only currently intent-level graph authoring commands', () => {
  const primary = semanticCommandDescriptorsForSurface('primary').map((descriptor) => descriptor.command).sort();
  assert.deepEqual(primary, ['project.amend', 'project.define']);
});

test('README leads ordinary agents to a generated primary semantic surface', async () => {
  const readme = await source('README.md');
  assert.match(readme, /Primary agent surface/);
  assert.match(readme, /primary-semantic-surface\.md/);
  assert.equal((await source('public/docs/primary-semantic-surface.md')).trimEnd(), renderPrimarySemanticSurface());
});

test('primary documentation excludes lower-level lifecycle and recovery commands', async () => {
  const primaryDoc = await source('public/docs/primary-semantic-surface.md');
  assert.match(primaryDoc, /project\.define/);
  assert.match(primaryDoc, /project\.amend/);
  assert.doesNotMatch(primaryDoc, /^## work\.settle$/m);
  assert.doesNotMatch(primaryDoc, /^## orchestration\.diagnose$/m);
});
