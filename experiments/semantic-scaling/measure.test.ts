import assert from 'node:assert/strict';
import test from 'node:test';

import {
  measureSemanticScaling,
  semanticScalingSummary,
  trustedUnitsForScope,
  validateSemanticScalingMeasurementPlan,
  type SemanticScalingMeasurementPlan,
  type SemanticScalingTcbReport,
} from './measure.ts';

const sources: Record<string, string> = {
  'a.ts': ['export const a = 1;', '', '// comment', 'export const shared = 2;'].join('\n'),
  'b.ts': ['export const b = 3;', 'export const tail = 4;'].join('\n'),
  'c.ts': ['export const c = 5;', 'export const d = 6;'].join('\n'),
};

const readSource = (path: string): string => {
  const source = sources[path];
  if (source === undefined) throw new Error(`missing synthetic source: ${path}`);
  return source;
};

const report: SemanticScalingTcbReport = {
  schema: 'overcenter-tcb-report',
  schema_version: 1,
  reconciliation: {
    admitted: true,
    baseline_revision: 'a'.repeat(40),
  },
  properties: [
    {
      id: 'general-settlement',
      hybrid_closure_semantic_loc: 3,
      hybrid_closure_sha256: 'general',
      hybrid_closure_files: ['a.ts', 'b.ts'],
      module_closure_files: ['a.ts'],
      symbol_closure_declarations: [
        {
          path: 'b.ts',
          symbol: 'b',
          start_line: 1,
          end_line: 1,
        },
      ],
      external_assumptions: ['runtime'],
      scope_sha256: 'scope-general',
    },
    {
      id: 'provider-profile',
      hybrid_closure_semantic_loc: 3,
      hybrid_closure_sha256: 'provider',
      hybrid_closure_files: ['b.ts', 'c.ts'],
      module_closure_files: ['b.ts'],
      symbol_closure_declarations: [
        {
          path: 'c.ts',
          symbol: 'c',
          start_line: 1,
          end_line: 1,
        },
      ],
      external_assumptions: ['runtime', 'provider-api'],
      scope_sha256: 'scope-provider',
    },
  ],
  architecture_tcb: {
    effects: [
      {
        effect_id: 'provider/write',
        hybrid_closure_semantic_loc: 3,
        hybrid_closure_sha256: 'effect',
        hybrid_closure_files: ['b.ts', 'c.ts'],
        hybrid_closure_semantic_line_ranges: [
          { path: 'b.ts', ranges: [[1, 2]] },
          { path: 'c.ts', ranges: [[1, 1]] },
        ],
      },
      {
        effect_id: 'task-specific/check',
        hybrid_closure_semantic_loc: 2,
        hybrid_closure_sha256: 'task-specific',
        hybrid_closure_files: ['c.ts'],
        hybrid_closure_semantic_line_ranges: [{ path: 'c.ts', ranges: [[1, 2]] }],
      },
    ],
  },
};

const plan: SemanticScalingMeasurementPlan = {
  schema: 'overcenter-semantic-scaling-measurement-plan/v1',
  tasks: [
    {
      task_id: 'baseline',
      rung: 'pure-computation',
      classification: 'convergent',
      claim: 'baseline',
      scopes: [{ kind: 'property', id: 'general-settlement', role: 'reused-general' }],
      evidence: ['baseline-proof'],
      observation_support: ['baseline-observation'],
    },
    {
      task_id: 'provider',
      rung: 'consequential-external-effect',
      classification: 'convergent',
      claim: 'provider',
      scopes: [
        { kind: 'property', id: 'general-settlement', role: 'reused-general' },
        { kind: 'property', id: 'provider-profile', role: 'provider-specific' },
        {
          kind: 'architecture-effect',
          id: 'provider/write',
          role: 'provider-specific',
        },
      ],
      evidence: ['provider-proof'],
      observation_support: ['provider-observation'],
    },
    {
      task_id: 'mirrored',
      rung: 'behavioral-bug-repair',
      classification: 'semantic-mirroring',
      claim: 'negative control',
      scopes: [
        { kind: 'property', id: 'general-settlement', role: 'reused-general' },
        {
          kind: 'architecture-effect',
          id: 'task-specific/check',
          role: 'task-specific',
        },
      ],
      evidence: ['negative-control'],
      observation_support: ['candidate-equivalent-check'],
    },
  ],
};

test('reconstructs exact hybrid semantic units from report evidence', () => {
  const units = trustedUnitsForScope(report.properties[0]!, readSource);
  assert.deepEqual([...units].sort(), ['a.ts:1', 'a.ts:4', 'b.ts:1']);
});

test('uses reported logical semantic spans instead of reconstructing physical lines', () => {
  const aLength = sources['a.ts']!.length;
  const bFirstStatementEnd = sources['b.ts']!.indexOf('\n');
  const units = trustedUnitsForScope(
    {
      ...report.properties[0]!,
      hybrid_closure_semantic_spans: [
        {
          path: 'a.ts',
          start_offset: 0,
          end_offset: aLength,
          semantic_loc: 2,
        },
        {
          path: 'b.ts',
          start_offset: 0,
          end_offset: bFirstStatementEnd,
          semantic_loc: 1,
        },
      ],
      hybrid_closure_semantic_line_ranges: [
        { path: 'a.ts', ranges: [[1, 4]] },
        { path: 'b.ts', ranges: [[1, 1]] },
      ],
    },
    readSource,
  );

  assert.deepEqual([...units].sort(), [
    `a.ts:0-${aLength}/0`,
    `a.ts:0-${aLength}/1`,
    `b.ts:0-${bFirstStatementEnd}/0`,
  ]);
});

test('logical semantic span evidence fails closed on overlap and count drift', () => {
  const base = {
    ...report.properties[0]!,
    hybrid_closure_files: ['a.ts'],
    hybrid_closure_semantic_loc: 2,
    hybrid_closure_semantic_spans: [
      { path: 'a.ts', start_offset: 0, end_offset: 20, semantic_loc: 1 },
      { path: 'a.ts', start_offset: 10, end_offset: 30, semantic_loc: 1 },
    ],
  };
  assert.throws(() => trustedUnitsForScope(base, readSource), /SEMANTIC_SCALING_TCB_SPAN_OVERLAP/);
  assert.throws(
    () =>
      trustedUnitsForScope(
        {
          ...base,
          hybrid_closure_semantic_spans: [
            { path: 'a.ts', start_offset: 0, end_offset: 20, semantic_loc: 1 },
          ],
        },
        readSource,
      ),
    /SEMANTIC_SCALING_TCB_RECONSTRUCTION_MISMATCH/,
  );
});

test('measures marginal TCB by deduplicated semantic units and keeps scope semantics separate', () => {
  const result = measureSemanticScaling(
    plan,
    report,
    'b'.repeat(40),
    'tcb-digest',
    'plan-digest',
    readSource,
  );

  assert.equal(result.tasks[0]?.trusted_semantic_loc, 3);
  assert.equal(result.tasks[0]?.marginal_semantic_loc, 3);

  assert.equal(result.tasks[1]?.trusted_semantic_loc, 5);
  assert.equal(result.tasks[1]?.marginal_semantic_loc, 2);
  assert.equal(result.tasks[1]?.provider_specific_marginal_semantic_loc, 2);
  assert.deepEqual(result.tasks[1]?.marginal_files, ['b.ts', 'c.ts']);
  assert.deepEqual(result.tasks[1]?.introduced_external_assumptions, ['provider-api']);
  assert.deepEqual(
    result.tasks[1]?.introduced_scopes.map((scope) => scope.key),
    ['architecture-effect:provider/write', 'property:provider-profile'],
  );

  assert.equal(result.tasks[2]?.trusted_semantic_loc, 5);
  assert.equal(result.tasks[2]?.marginal_semantic_loc, 1);
  assert.equal(result.tasks[2]?.task_specific_marginal_semantic_loc, 1);
  assert.deepEqual(result.tasks[2]?.marginal_files, ['c.ts']);
});

test('scope overlap cannot inflate marginal trusted semantic LOC', () => {
  const result = measureSemanticScaling(
    {
      ...plan,
      tasks: [plan.tasks[1]!],
    },
    report,
    'c'.repeat(40),
    'tcb-digest',
    'plan-digest',
    readSource,
  );
  assert.equal(result.tasks[0]?.trusted_semantic_loc, 5);
  assert.equal(result.tasks[0]?.marginal_semantic_loc, 5);
  assert.equal(result.tasks[0]?.provider_specific_marginal_semantic_loc, 3);
});

test('unknown TCB scopes fail closed', () => {
  const invalid: SemanticScalingMeasurementPlan = {
    ...plan,
    tasks: [
      {
        ...plan.tasks[0]!,
        scopes: [{ kind: 'property', id: 'missing', role: 'reused-general' }],
      },
    ],
  };
  assert.throws(
    () =>
      measureSemanticScaling(
        invalid,
        report,
        'd'.repeat(40),
        'tcb-digest',
        'plan-digest',
        readSource,
      ),
    /SEMANTIC_SCALING_TCB_PROPERTY_UNKNOWN/,
  );
});

test('TCB reconstruction fails closed when report counts do not match source', () => {
  assert.throws(
    () =>
      trustedUnitsForScope(
        {
          ...report.properties[0]!,
          hybrid_closure_semantic_loc: 4,
        },
        readSource,
      ),
    /SEMANTIC_SCALING_TCB_RECONSTRUCTION_MISMATCH/,
  );
});

test('measurement plan vocabulary is fail closed', () => {
  const invalid = structuredClone(plan) as unknown as {
    schema: string;
    tasks: Array<Record<string, unknown>>;
  };
  invalid.tasks[0]!.rung = 'semantic-soup';
  assert.throws(
    () => validateSemanticScalingMeasurementPlan(invalid),
    /SEMANTIC_SCALING_MEASUREMENT_INVALID_RUNG/,
  );
});

test('summary keeps LOC and semantic-scope deltas visibly separate', () => {
  const result = measureSemanticScaling(
    plan,
    report,
    'e'.repeat(40),
    'tcb-digest',
    'plan-digest',
    readSource,
  );
  const summary = semanticScalingSummary(result);
  assert.match(summary, /Marginal vs prior ladder/);
  assert.match(summary, /Provider-specific marginal/);
  assert.match(summary, /New external assumptions/);
  assert.match(summary, /zero-LOC delta cannot erase semantic growth/);
});

test('frontier-limited measurements require an explicit narrowed claim and residual judgment', () => {
  const frontier: SemanticScalingMeasurementPlan = {
    schema: 'overcenter-semantic-scaling-measurement-plan/v1',
    tasks: [
      {
        task_id: 'behavioral-frontier',
        rung: 'behavioral-bug-repair',
        classification: 'frontier-limited',
        claim: 'the exact regression passed',
        narrowed_from: 'the bug is absent in every relevant behavior',
        residual_judgment: 'whether the regression completely characterizes the bug',
        scopes: [{ kind: 'property', id: 'general-settlement', role: 'reused-general' }],
        evidence: ['behavioral-regression'],
        observation_support: ['exact revision and regression result'],
      },
    ],
  };

  assert.deepEqual(validateSemanticScalingMeasurementPlan(frontier), frontier);

  const result = measureSemanticScaling(
    frontier,
    report,
    'f'.repeat(40),
    'tcb-digest',
    'plan-digest',
    readSource,
  );
  assert.equal(result.tasks[0]?.classification, 'frontier-limited');
  assert.equal(result.tasks[0]?.narrowed_from, 'the bug is absent in every relevant behavior');
  assert.equal(
    result.tasks[0]?.residual_judgment,
    'whether the regression completely characterizes the bug',
  );
  assert.match(
    semanticScalingSummary(result),
    /whether the regression completely characterizes the bug/,
  );
});

test('frontier metadata cannot be omitted or smuggled into another classification', () => {
  const missingResidual = structuredClone(plan.tasks[0]!);
  missingResidual.classification = 'frontier-limited';
  assert.throws(
    () =>
      validateSemanticScalingMeasurementPlan({
        schema: 'overcenter-semantic-scaling-measurement-plan/v1',
        tasks: [missingResidual],
      }),
    /SEMANTIC_SCALING_FRONTIER_EVIDENCE_REQUIRED/,
  );

  const unexpectedResidual = {
    ...structuredClone(plan.tasks[0]!),
    residual_judgment: 'hidden semantic doubt',
  };
  assert.throws(
    () =>
      validateSemanticScalingMeasurementPlan({
        schema: 'overcenter-semantic-scaling-measurement-plan/v1',
        tasks: [unexpectedResidual],
      }),
    /SEMANTIC_SCALING_FRONTIER_EVIDENCE_UNEXPECTED/,
  );
});
