import assert from 'node:assert/strict';
import test from 'node:test';

import { executionEvidenceReceipt } from '../src/execution/evidence-receipt.ts';
import {
  ASSURANCE_EVIDENCE_NEED_SCHEMA,
  deriveAssuranceEvidenceNeeds,
  type AssuranceEvidenceNeed,
} from '../src/source/assurance-evidence-needs.ts';
import type {
  TransactionAssuranceFrontier,
  TransactionAssurancePlan,
  TransactionEvidenceCandidate,
} from '../src/source/transaction-planner.ts';

const BASE = 'a'.repeat(40);
const CANDIDATE = 'b'.repeat(40);

function evidence(
  evidence_id: string,
  proposition_ids: string[],
  package_scripts: string[] = ['test:unit'],
): TransactionEvidenceCandidate {
  return {
    evidence_id,
    proposition_ids,
    obligation_ids: proposition_ids
      .filter((proposition) => proposition.startsWith('obligation:'))
      .map((proposition) => proposition.slice('obligation:'.length)),
    artifact_ids: [`proof/${evidence_id}.ts`],
    package_scripts,
    uses_package_runtime: false,
  };
}

function frontier(
  revision: string,
  required_propositions: string[],
  candidates: TransactionEvidenceCandidate[],
  baseline_sha256: string | null = null,
): TransactionAssuranceFrontier {
  return {
    coordinate: `revision:${revision}`,
    revision,
    model_sha256: 'd'.repeat(64),
    dependency_sha256: revision === BASE ? 'e'.repeat(64) : 'f'.repeat(64),
    baseline_sha256,
    required_propositions,
    candidates,
  };
}

function plan(frontiers: TransactionAssuranceFrontier[]): TransactionAssurancePlan {
  return {
    base_revision: BASE,
    candidate_revision: CANDIDATE,
    candidate_tree: 'c'.repeat(40),
    model_sha256: '1'.repeat(64),
    dependency_sha256: '2'.repeat(64),
    changed_artifacts: ['src/z.ts', 'src/a.ts'],
    impacts: [],
    proof_plans: [],
    evidence: [],
    evidence_frontiers: frontiers,
    coverage_gaps: [],
    validation_mode: 'selective',
    baseline_id: null,
    baseline_sha256: null,
  };
}

function receiptFor(
  need: AssuranceEvidenceNeed,
  result: 'satisfied' | 'unsatisfied' = 'satisfied',
) {
  return executionEvidenceReceipt(
    {
      identity: need.identity,
      inputs: need.inputs,
      outputs: { evidence_sha256: '3'.repeat(64) },
      semantic_evidence: { verified: 'true' },
    },
    result,
  );
}

test('base and candidate requirements keep their exact assurance coordinates', () => {
  const candidate = evidence('shared-proof', ['proof:a', 'proof:b']);
  const needs = deriveAssuranceEvidenceNeeds(
    plan([
      frontier(BASE, ['proof:a', 'proof:b'], [candidate]),
      frontier(CANDIDATE, ['proof:a', 'proof:b'], [candidate]),
    ]),
  );

  assert.equal(needs.length, 2);
  assert.deepEqual(
    needs.map((need) => need.identity),
    [
      { evidence_id: 'shared-proof', revision: BASE },
      { evidence_id: 'shared-proof', revision: CANDIDATE },
    ],
  );
  assert.equal(needs[0]!.inputs.coordinate, `revision:${BASE}`);
  assert.equal(needs[1]!.inputs.coordinate, `revision:${CANDIDATE}`);
});

test('satisfied exact-coordinate evidence shrinks only that frontier', () => {
  const candidate = evidence('shared-proof', ['proof:a', 'proof:b']);
  const transaction = plan([
    frontier(BASE, ['proof:a', 'proof:b'], [candidate]),
    frontier(CANDIDATE, ['proof:a', 'proof:b'], [candidate]),
  ]);
  const original = deriveAssuranceEvidenceNeeds(transaction);
  const remaining = deriveAssuranceEvidenceNeeds(transaction, [receiptFor(original[0]!)]);
  assert.deepEqual(
    remaining.map((need) => need.identity),
    [{ evidence_id: 'shared-proof', revision: CANDIDATE }],
  );
});

test('unsatisfied evidence contributes no support', () => {
  const transaction = plan([
    frontier(CANDIDATE, ['proof:a'], [evidence('a-proof', ['proof:a'])]),
  ]);
  const need = deriveAssuranceEvidenceNeeds(transaction)[0]!;
  assert.deepEqual(
    deriveAssuranceEvidenceNeeds(transaction, [receiptFor(need, 'unsatisfied')]),
    [need],
  );
});

test('frontier is re-minimized after support instead of subtracting only the prior selection', () => {
  const firstPlan = plan([
    frontier(BASE, ['proof:a', 'proof:b'], [
      evidence('a-proof', ['proof:a']),
      evidence('b-proof', ['proof:b']),
    ]),
  ]);
  const aNeed = deriveAssuranceEvidenceNeeds(firstPlan).find(
    (need) => need.identity.evidence_id === 'a-proof',
  )!;

  const withAlternative = plan([
    frontier(BASE, ['proof:a', 'proof:b'], [
      evidence('a-proof', ['proof:a']),
      evidence('b-proof', ['proof:b']),
      evidence('shared-proof', ['proof:a', 'proof:b']),
    ]),
  ]);
  assert.deepEqual(
    deriveAssuranceEvidenceNeeds(withAlternative).map((need) => need.identity.evidence_id),
    ['shared-proof'],
  );
  assert.deepEqual(
    deriveAssuranceEvidenceNeeds(withAlternative, [receiptFor(aNeed)]).map(
      (need) => need.identity.evidence_id,
    ),
    ['b-proof'],
  );
});

test('stale-coordinate satisfied evidence contributes no support', () => {
  const candidate = evidence('shared-proof', ['proof:a']);
  const transaction = plan([frontier(CANDIDATE, ['proof:a'], [candidate])]);
  const need = deriveAssuranceEvidenceNeeds(transaction)[0]!;
  const stale = executionEvidenceReceipt(
    {
      identity: { ...need.identity, revision: BASE },
      inputs: { ...need.inputs, coordinate: `revision:${BASE}` },
      outputs: { evidence_sha256: '3'.repeat(64) },
      semantic_evidence: { verified: 'true' },
    },
    'satisfied',
  );
  assert.deepEqual(deriveAssuranceEvidenceNeeds(transaction, [stale]), [need]);
});

test('baseline validation is an explicit candidate-bound neutral evidence need', () => {
  const proposition = 'baseline:repository-checks';
  const baseline = plan([
    frontier(
      CANDIDATE,
      [proposition],
      [
        {
          ...evidence(proposition, [proposition], ['lint', 'test:unit', 'typecheck']),
          artifact_ids: [],
          uses_package_runtime: true,
        },
      ],
      '4'.repeat(64),
    ),
  ]);
  baseline.validation_mode = 'baseline';
  baseline.baseline_id = 'repository-checks';
  baseline.baseline_sha256 = '4'.repeat(64);

  const needs = deriveAssuranceEvidenceNeeds(baseline);
  assert.equal(needs.length, 1);
  assert.deepEqual(needs[0]!.identity, {
    evidence_id: proposition,
    revision: CANDIDATE,
  });
  assert.equal(needs[0]!.inputs.baseline_sha256, '4'.repeat(64));
  assert.equal(needs[0]!.inputs.package_scripts, '["lint","test:unit","typecheck"]');
});

test('equivalent frontier state produces the same canonically ordered needs', () => {
  const original = plan([
    frontier(BASE, ['proof:a', 'proof:b'], [
      evidence('a-proof', ['proof:a']),
      evidence('b-proof', ['proof:b']),
    ]),
  ]);
  const reordered = plan([
    frontier(BASE, ['proof:b', 'proof:a'], [
      evidence('b-proof', ['proof:b']),
      evidence('a-proof', ['proof:a']),
    ]),
  ]);
  assert.deepEqual(deriveAssuranceEvidenceNeeds(reordered), deriveAssuranceEvidenceNeeds(original));
});

test('realization recipe is semantic input while scheduler metadata is not', () => {
  const original = plan([frontier(CANDIDATE, ['proof:a'], [evidence('a-proof', ['proof:a'])])]);
  const first = deriveAssuranceEvidenceNeeds(original);
  const changedRecipe = structuredClone(original);
  changedRecipe.evidence_frontiers[0]!.candidates[0]!.package_scripts = ['different-proof'];
  assert.notDeepEqual(
    deriveAssuranceEvidenceNeeds(changedRecipe).map((need) => need.need_id),
    first.map((need) => need.need_id),
  );

  const schedulerNoise = {
    ...original,
    scheduler: {
      executor: 'github',
      queue: 'fast',
      retries: 99,
      status: 'complete',
      priority: 1,
    },
  } as TransactionAssurancePlan;
  assert.deepEqual(deriveAssuranceEvidenceNeeds(schedulerNoise), first);

  for (const need of first) {
    assert.equal(need.schema, ASSURANCE_EVIDENCE_NEED_SCHEMA);
    assert.match(need.need_id, /^assurance-evidence:[0-9a-f]{64}$/);
    const fields = new Set([
      ...Object.keys(need),
      ...Object.keys(need.identity),
      ...Object.keys(need.inputs),
    ]);
    for (const forbidden of [
      'executor',
      'provider',
      'queue',
      'attempt',
      'retry',
      'retries',
      'backoff',
      'priority',
      'status',
      'authority',
      'authorized',
      'admission',
      'decision',
    ])
      assert.equal(fields.has(forbidden), false, forbidden);
  }
});
