import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileProjectGoal,
  PROJECT_GOAL_SATISFACTION_SCHEMA,
  PROJECT_GOAL_SCHEMA,
} from '../src/authority/project-goal.ts';

const goal = {
  schema: PROJECT_GOAL_SCHEMA,
  id: 'project-goal:strength',
  objective: 'Improve the project until external strength evidence satisfies the goal.',
  writable_paths: ['README.md'],
  writable_trees: ['src', 'test'],
} as const;

test('project goal emits one source obligation bound to the exact project revision', () => {
  const firstSha = 'a'.repeat(40);
  const secondSha = 'b'.repeat(40);
  const first = compileProjectGoal(goal, firstSha);
  const second = compileProjectGoal(goal, secondSha);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0]?.id, goal.id);
  assert.equal(first[0]?.packet.kind, 'source-change');
  assert.equal(first[0]?.postcondition.verifier, 'source-integration/v1');
  assert.deepEqual(first[0]?.packet.writable_trees, ['src', 'test']);
  assert.deepEqual(first[0]?.packet.context, {
    schema: 'overcenter-project-goal-iteration/v1',
    project_source_sha: firstSha,
  });
  assert.notDeepEqual(first[0]?.packet.context, second[0]?.packet.context);
});

test('trusted satisfaction retires the long horizon goal', () => {
  assert.deepEqual(
    compileProjectGoal(goal, 'a'.repeat(40), {
      schema: PROJECT_GOAL_SATISFACTION_SCHEMA,
      goal_id: goal.id,
      state: 'satisfied',
      evidence: {
        provider: 'external-ranking',
        rank: 1,
      },
    }),
    [],
  );
});

test('project goal fails closed on mismatched or empty satisfaction evidence', () => {
  assert.throws(
    () =>
      compileProjectGoal(goal, 'a'.repeat(40), {
        schema: PROJECT_GOAL_SATISFACTION_SCHEMA,
        goal_id: 'project-goal:other',
        state: 'satisfied',
        evidence: { rank: 1 },
      }),
    /PROJECT_GOAL_SATISFACTION_GOAL_MISMATCH/,
  );
  assert.throws(
    () =>
      compileProjectGoal(goal, 'a'.repeat(40), {
        schema: PROJECT_GOAL_SATISFACTION_SCHEMA,
        goal_id: goal.id,
        state: 'satisfied',
        evidence: {},
      }),
    /PROJECT_GOAL_SATISFACTION_EVIDENCE_INVALID/,
  );
});

test('project goal rejects control-plane writable trees', () => {
  assert.throws(
    () =>
      compileProjectGoal(
        {
          ...goal,
          writable_trees: ['.github'],
        },
        'a'.repeat(40),
      ),
    /SOURCE_TASK_WRITABLE_TREE_INVALID/,
  );
});
