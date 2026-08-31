import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('project-transition lease runtime derives continuation evidence from the semantic kernel', async () => {
  const source = await readFile(new URL('../lib/project-transition-leases.js', import.meta.url), 'utf8');

  assert.match(source, /deriveProjectTransitionContinuationEvidence/, 'lease runtime does not consume canonical continuation-evidence derivation');
  assert.doesNotMatch(source, /mutation_scope_unchanged\s*:\s*true/, 'lease runtime still asserts mutation-scope validity outside the semantic kernel');
});