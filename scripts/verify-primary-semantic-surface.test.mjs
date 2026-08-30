import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { semanticCommandDescriptorsForSurface } from '../lib/semantic-command-descriptors.js';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('primary agent surface exposes graph authoring and graph advancement from metadata', () => {
  const primary = semanticCommandDescriptorsForSurface('primary').map((descriptor) => descriptor.command).sort();
  assert.deepEqual(primary, ['orchestration.advance', 'project.amend', 'project.define']);
});

test('README leads ordinary agents to generated primary semantic documentation', async () => {
  const readme = await source('README.md');
  assert.match(readme, /Primary agent surface/);
  assert.match(readme, /primary-semantic-surface\.md/);

  const primaryDoc = await source('public/docs/primary-semantic-surface.md');
  assert.match(primaryDoc, /orchestration\.advance/);
  assert.match(primaryDoc, /project\.define/);
  assert.match(primaryDoc, /project\.amend/);
  assert.doesNotMatch(primaryDoc, /work\.settle/);
  assert.doesNotMatch(primaryDoc, /orchestration\.diagnose/);
});
