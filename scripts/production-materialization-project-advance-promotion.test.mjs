import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('GCP semantic worker injects the promotion-aware project.advance runtime', async () => {
  const runtime = await source('scripts/cloud-run-semantic-runtime.mjs');
  assert.match(runtime, /createPostgresProjectAdvanceRuntime/);
  assert.match(runtime, /providers:Object\.freeze\(\{ \.\.\.providers, projectAdvance \}\)/);
});

test('shared project.advance composition uses one promotion-aware transition service', async () => {
  const runtime = await source('lib/project-advance-runtime.js');
  assert.match(runtime, /createPostgresProjectTransitionLeaseService\(providerOptions\)/);
  assert.match(runtime, /createPostgresOrchestrationAdvanceService\(\{ \.\.\.providerOptions, projectTransitions \}\)/);
  assert.match(runtime, /createProjectAdvancePromotionRuntime\(\{ host, projectTransitions \}\)/);
});
