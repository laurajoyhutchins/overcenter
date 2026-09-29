import assert from 'node:assert/strict';
import test from 'node:test';

import { planCodeDeletions } from '../scripts/lib/code-deletion-plan.ts';
import type { CodeWitnessReport } from '../src/repository/code-witness.ts';

const revision = 'a'.repeat(40);

function report(): CodeWitnessReport {
  return {
    schema: 'overcenter-code-witness-report/v1',
    source_revision: revision,
    summary: {
      observed_symbols: 4,
      root_symbols: 1,
      reachable_symbols: 2,
      unwitnessed_symbols: 2,
      simplification_candidates: 1,
    },
    findings: [
      {
        code: 'SINGLE_CALLER_TRANSPARENT_WRAPPER',
        path: 'src/a.ts',
        symbol: 'wrapper',
        start_line: 2,
        evidence: ['one caller'],
      },
      {
        code: 'UNWITNESSED_PRIVATE_SYMBOL',
        path: 'src/z.ts',
        symbol: 'later',
        start_line: 20,
        evidence: ['unwitnessed'],
      },
      {
        code: 'UNWITNESSED_PRIVATE_SYMBOL',
        path: 'src/a.ts',
        symbol: 'first',
        start_line: 10,
        evidence: ['unwitnessed'],
      },
    ],
  };
}

test('planner emits only deletion-proof eligible findings in deterministic order', () => {
  const plan = planCodeDeletions(report(), 4);
  assert.equal(plan.source_revision, revision);
  assert.equal(plan.eligible_findings, 2);
  assert.deepEqual(
    plan.items.map((item) => item.selector),
    ['src/a.ts#first', 'src/z.ts#later'],
  );
});

test('planner bounds remediation work without changing eligibility', () => {
  const plan = planCodeDeletions(report(), 1);
  assert.equal(plan.eligible_findings, 2);
  assert.deepEqual(
    plan.items.map((item) => item.selector),
    ['src/a.ts#first'],
  );
});

test('planner rejects invalid bounds', () => {
  assert.throws(() => planCodeDeletions(report(), 0), /PLAN_LIMIT_INVALID/);
});
