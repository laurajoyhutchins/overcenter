import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCounterfactualDeletionProof,
  parseCodeSymbolSelector,
  selectCounterfactualDeletion,
} from '../src/repository/code-deletion-proof.ts';
import type { CodeWitnessReport } from '../src/repository/code-witness.ts';

const revision = 'a'.repeat(40);

function report(): CodeWitnessReport {
  return {
    schema: 'overcenter-code-witness-report/v1',
    source_revision: revision,
    summary: {
      observed_symbols: 2,
      root_symbols: 1,
      reachable_symbols: 1,
      unwitnessed_symbols: 1,
      simplification_candidates: 0,
    },
    findings: [
      {
        code: 'UNWITNESSED_PRIVATE_SYMBOL',
        path: 'src/dead.ts',
        symbol: 'dead',
        start_line: 10,
        evidence: ['not reachable'],
      },
      {
        code: 'SINGLE_CALLER_TRANSPARENT_WRAPPER',
        path: 'src/live.ts',
        symbol: 'forward',
        start_line: 20,
        evidence: ['one caller'],
      },
    ],
  };
}

test('selector identifies one production symbol', () => {
  assert.deepEqual(parseCodeSymbolSelector('src/dead.ts#dead'), {
    path: 'src/dead.ts',
    symbol: 'dead',
  });
  assert.throws(() => parseCodeSymbolSelector('test/dead.ts#dead'), /SELECTOR_INVALID/);
  assert.throws(() => parseCodeSymbolSelector('src/dead.ts'), /SELECTOR_INVALID/);
});

test('only an exact unwitnessed finding is deletion-proof eligible', () => {
  assert.equal(
    selectCounterfactualDeletion(report(), revision, 'src/dead.ts#dead').symbol,
    'dead',
  );
  assert.throws(
    () => selectCounterfactualDeletion(report(), revision, 'src/live.ts#forward'),
    /UNWITNESSED_FINDING_REQUIRED/,
  );
});

test('stale witness evidence cannot authorize a counterfactual deletion', () => {
  assert.throws(
    () => selectCounterfactualDeletion(report(), 'b'.repeat(40), 'src/dead.ts#dead'),
    /REPORT_REVISION_MISMATCH/,
  );
});

test('all deterministic evidence must pass before preservation is reported', () => {
  const accepted = buildCounterfactualDeletionProof({
    source_revision: revision,
    candidate_revision: 'b'.repeat(40),
    selector: 'src/dead.ts#dead',
    source_sha256: 'c'.repeat(64),
    candidate_source_sha256: 'd'.repeat(64),
    evidence: [
      { name: 'typecheck', passed: true },
      { name: 'unit-tests', passed: true },
    ],
  });
  assert.equal(accepted.status, 'deterministic-evidence-preserved');

  const rejected = buildCounterfactualDeletionProof({
    source_revision: revision,
    candidate_revision: 'b'.repeat(40),
    selector: 'src/dead.ts#dead',
    source_sha256: 'c'.repeat(64),
    candidate_source_sha256: 'd'.repeat(64),
    evidence: [
      { name: 'typecheck', passed: true },
      { name: 'unit-tests', passed: false },
    ],
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason_code, 'DETERMINISTIC_EVIDENCE_FAILED');
});
