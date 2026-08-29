import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalProjectDefinition,
  applyProjectDefinitionAmendment,
} from '../lib/project-authoring.js';

const base = {
  schema: 'overcenter-project-definition-v1',
  project_ref: 'github:example/project',
  transitions: [
    { id:'foundation', priority:10, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
  ],
};

test('canonical project authoring normalizes order without exposing runtime state', () => {
  const result = canonicalProjectDefinition({
    ...base,
    transitions: [
      { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
      base.transitions[0],
    ],
  });
  assert.deepEqual(result.transitions.map((transition) => transition.id), ['foundation', 'second']);
  assert.equal('state' in result.transitions[0], false);
  assert.equal('lifecycle' in result.transitions[0], false);
});

test('semantic amendment validates the complete candidate graph', () => {
  const amended = applyProjectDefinitionAmendment(base, {
    upsert_transitions: [
      { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  });
  assert.deepEqual(amended.definition.transitions.map((transition) => transition.id), ['foundation', 'second']);
  assert.deepEqual(amended.diff.added, ['second']);
  assert.deepEqual(amended.diff.changed, []);
  assert.deepEqual(amended.diff.removed, []);

  assert.throws(() => applyProjectDefinitionAmendment(base, {
    upsert_transitions: [
      { id:'dangling', priority:1, requires:['missing'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  }), /missing dependency/);

  assert.throws(() => applyProjectDefinitionAmendment(base, {
    upsert_transitions: [
      { id:'foundation', priority:10, requires:['second'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
      { id:'second', priority:5, requires:['foundation'], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  }), /cycle/);
});

test('confirmed transition meaning cannot be silently rewritten', () => {
  assert.throws(() => applyProjectDefinitionAmendment(base, {
    confirmed_transition_ids: ['foundation'],
    upsert_transitions: [
      { id:'foundation', priority:99, requires:[], executor:{ kind:'agent', role:'implementation', skill:'test-driven-development' } },
    ],
  }), /confirmed transition/);
});