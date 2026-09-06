import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileProjectAuthoringCandidate } from '../lib/project-authoring-candidate-reconciliation.js';

const staged = 'a'.repeat(40);
const derived = 'b'.repeat(40);

const base = {
  staged_revision: staged,
  current_revision: derived,
  definition_fingerprint: 'definition-v1',
  staged_definition_fingerprint: 'definition-v1',
  graph_fingerprint: 'graph-v1',
  staged_graph_fingerprint: 'graph-v1',
  descendant_of_staged: true,
};

test('authorized derivative candidate is adopted only with fresh exact-head verification', () => {
  assert.deepEqual(reconcileProjectAuthoringCandidate({ ...base, verified_revision: derived }), {
    candidate_revision: derived,
    staged_revision: staged,
    advanced: true,
  });
});

test('stale verification bound to the staged candidate is rejected', () => {
  assert.throws(
    () => reconcileProjectAuthoringCandidate({ ...base, verified_revision: staged }),
    (error) => error?.code === 'PROJECT_AUTHORING_CANDIDATE_VERIFICATION_STALE' && error?.may_have_mutated === false,
  );
});

test('unrecognized head movement and semantic drift fail closed', () => {
  for (const input of [
    { ...base, descendant_of_staged:false, verified_revision:derived },
    { ...base, definition_fingerprint:'definition-v2', verified_revision:derived },
    { ...base, graph_fingerprint:'graph-v2', verified_revision:derived },
  ]) {
    assert.throws(
      () => reconcileProjectAuthoringCandidate(input),
      (error) => error?.code === 'PROJECT_AUTHORING_CANDIDATE_RECONCILIATION_REQUIRED' && error?.may_have_mutated === false,
    );
  }
});