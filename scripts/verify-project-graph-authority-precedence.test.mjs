import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileProjectTransitionChange } from '../lib/project-graph-reconciliation.js';

test('invalid continuation authority outranks dependency-only reconciliation', () => {
  const previous = {
    transition_id: 'transition-a',
    definition_fingerprint: 'definition-a',
    dependency_fingerprint: 'dependencies-before',
  };
  const current = {
    transition_id: 'transition-a',
    definition_fingerprint: 'definition-a',
    dependency_fingerprint: 'dependencies-after',
  };

  const reconciliation = reconcileProjectTransitionChange(previous, current, {
    mutation_scope_unchanged: false,
    required_authority_valid: false,
  });

  assert.deepEqual(reconciliation, {
    kind: 'authority-invalidated',
    transition_id: 'transition-a',
    definition_fingerprint: 'definition-a',
    mutation_scope_unchanged: false,
    required_authority_valid: false,
    may_continue_existing_authority: false,
    may_preserve_confirmation: false,
  });
});