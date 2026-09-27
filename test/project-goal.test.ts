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
  writable_paths: ['README.md', 'src/feature.ts', 'test/feature.test.ts'],
} as const;

test('project goal emits one source obligation bound to the exact project revision', () => {
  const firstSha = 'a'.repeat(40);
  const secondSha = 'b'.repeat(40);
  const first = compileProjectGoal(goal, firstSha);
  const second = compileProjectGoal(goal, secondSha);

  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  const firstGoal = first[0];
  const secondGoal = second[0];
  assert.ok(firstGoal);
  assert.ok(secondGoal);
  assert.ok(firstGoal.packet);
  assert.ok(secondGoal.packet);
  assert.equal(firstGoal.id, goal.id);
  assert.equal(firstGoal.packet.kind, 'source-change');
  assert.equal(firstGoal.postcondition.verifier, 'source-integration/v1');
  assert.deepEqual(firstGoal.packet.writable_paths, [
    'README.md',
    'src/feature.ts',
    'test/feature.test.ts',
  ]);
  assert.deepEqual(firstGoal.packet.context, {
    schema: 'overcenter-project-goal-iteration/v1',
    project_source_sha: firstSha,
  });
  assert.notDeepEqual(firstGoal.packet.context, secondGoal.packet.context);
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

test('project goal rejects control-plane writable paths', () => {
  assert.throws(
    () =>
      compileProjectGoal(
        {
          ...goal,
          writable_paths: ['.github/workflows/evil.yml'],
        },
        'a'.repeat(40),
      ),
    /SOURCE_TASK_WRITABLE_PATH_INVALID/,
  );
});
