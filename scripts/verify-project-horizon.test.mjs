import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import './verify-orchestration-horizon-target.test.mjs';
import { runProjectHorizonTests } from '../lib/project-horizon.test.js';

test('project horizon semantics', async () => {
  const result = await runProjectHorizonTests();
  assert.equal(result.ok, true, JSON.stringify(result.tests.filter((entry) => !entry.ok), null, 2));
  assert.equal(result.failed, 0);
});

test('target architecture separates reachability discipline from post-advance proof', async () => {
  const definition = JSON.parse(await readFile(new URL('../.overcenter/definitions/target-architecture.json', import.meta.url), 'utf8'));
  const transitions = new Map(definition.transitions.map((transition) => [transition.id, transition]));
  const advance = transitions.get('expose-orchestration-advance');
  const proof = transitions.get('prove-orchestration-advance-production-reachability');
  const driver = transitions.get('add-targeted-project-driver');

  assert.ok(advance, 'target graph is missing expose-orchestration-advance');
  assert.ok(advance.requires.includes('require-production-reachability'), 'advance is not gated by pre-advance reachability verification discipline');
  assert.ok(proof, 'target graph is missing post-advance production reachability proof');
  assert.deepEqual(proof.requires, ['expose-orchestration-advance']);
  assert.ok(driver, 'target graph is missing add-targeted-project-driver');
  assert.deepEqual(driver.requires, ['prove-orchestration-advance-production-reachability']);
});