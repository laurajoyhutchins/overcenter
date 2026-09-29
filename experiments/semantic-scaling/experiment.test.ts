import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  classifySemanticScaling,
  evaluateSemanticScalingFixture,
  validateSemanticScalingFixture,
  type SemanticScalingTask,
} from './experiment.ts';

const fixture = validateSemanticScalingFixture(
  JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')),
);

test('preregistered semantic-scaling fixtures retain their expected classifications', () => {
  for (const task of fixture.tasks) {
    assert.equal(classifySemanticScaling(task), task.expected_classification, task.task_id);
  }
});

test('the negative control detects semantic mirroring', () => {
  const task = fixture.tasks.find(
    (candidate) => candidate.task_id === 'mirrored-bug-repair-negative-control',
  );
  assert.ok(task);
  assert.equal(classifySemanticScaling(task), 'semantic-mirroring');
  assert.ok(
    task.trusted_surfaces.some(
      (surface) =>
        surface.authority_bearing &&
        surface.scope === 'task-specific' &&
        surface.semantic_relation === 'candidate-equivalent',
    ),
  );
});

test('narrowing the authoritative claim preserves the unresolved judgment frontier', () => {
  const task = fixture.tasks.find(
    (candidate) => candidate.task_id === 'architectural-intent-frontier',
  );
  assert.ok(task);
  assert.equal(classifySemanticScaling(task), 'frontier-limited');
  assert.equal(task.authoritative_claim.kind, 'attested-judgment');
  assert.ok(task.authoritative_claim.narrowed_from);
  assert.ok(task.residual_judgment);
});

test('unsupported observation cannot be promoted by adding deterministic plumbing', () => {
  const task = fixture.tasks.find(
    (candidate) => candidate.task_id === 'weakly-observable-external-effect',
  );
  assert.ok(task);

  const withMoreMachinery: SemanticScalingTask = {
    ...structuredClone(task),
    trusted_surfaces: [
      ...task.trusted_surfaces,
      {
        id: 'more-deterministic-recovery-code',
        authority_bearing: true,
        scope: 'new-reusable',
        semantic_relation: 'general-proof-primitive',
      },
    ],
  };

  assert.equal(classifySemanticScaling(withMoreMachinery), 'unsupported');
});

test('surface ordering cannot change classification or comparison output', () => {
  const first = fixture.tasks.find((candidate) => candidate.task_id === 'hostile-evidence-refresh');
  assert.ok(first);

  const reordered = structuredClone(first);
  reordered.trusted_surfaces.reverse();

  assert.equal(classifySemanticScaling(first), classifySemanticScaling(reordered));

  const originalResult = evaluateSemanticScalingFixture({
    schema: fixture.schema,
    tasks: [first],
  });
  const reorderedResult = evaluateSemanticScalingFixture({
    schema: fixture.schema,
    tasks: [reordered],
  });
  assert.deepEqual(originalResult, reorderedResult);
});

test('task-specific trusted semantics count by authority role rather than file location', () => {
  const task = structuredClone(
    fixture.tasks.find((candidate) => candidate.task_id === 'mirrored-bug-repair-negative-control'),
  );
  assert.ok(task);

  task.trusted_surfaces = task.trusted_surfaces.map((surface) =>
    surface.id === 'bug-specific-correctness-interpreter'
      ? { ...surface, id: 'generated/elsewhere/bug-specific-correctness-interpreter' }
      : surface,
  );

  assert.equal(classifySemanticScaling(task), 'semantic-mirroring');
});

test('unknown semantic vocabulary fails closed before classification', () => {
  const invalidRung = structuredClone(fixture) as unknown as {
    tasks: Array<Record<string, unknown>>;
  };
  invalidRung.tasks[0].rung = 'semantic-soup';
  assert.throws(() => validateSemanticScalingFixture(invalidRung), /SEMANTIC_SCALING_INVALID_RUNG/);

  const invalidRoute = structuredClone(fixture) as unknown as {
    tasks: Array<Record<string, unknown>>;
  };
  invalidRoute.tasks[0].judgment_route = 'agent-decides';
  assert.throws(
    () => validateSemanticScalingFixture(invalidRoute),
    /SEMANTIC_SCALING_INVALID_JUDGMENT_ROUTE/,
  );
});
