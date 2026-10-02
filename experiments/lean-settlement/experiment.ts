import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { projectReceipt } from '../../src/authority/replay.ts';
import { RECEIPT_SCHEMA, type ReceiptFact, type ReceiptKind } from '../../src/authority/facts.ts';
import {
  authoritativeAbsenceEvidence,
  observationVerified,
} from '../../src/observation/observe.ts';
import { localFileEnoentEvidence } from '../../src/observation/evidence.ts';
import { reservedEffectReplaySafe } from '../../src/effect-adapter.ts';
import { settlementSemantics } from '../../src/semantics.ts';
import { sha256 } from '../../src/digest.ts';
import type { Obligation, Observation } from '../../src/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEAN = process.env.LEAN_SETTLEMENT_BIN ?? 'lean';
const KERNEL = resolve(HERE, 'Settlement.lean');

type LeanKind =
  | '.observation'
  | '.judgmentRequired'
  | '.executionTerminated'
  | '.effectNotDispatched'
  | '.sourceRetry';
type LeanDisposition = '.done' | '.ready' | '.recoveryRequired' | '.waiting';

const settledAt = '2026-10-01T00:00:00.000Z';
const path = '/tmp/settlement-micro';
const content = 'expected';
const digest = sha256(content);

const finalWork: Obligation = {
  id: 'final-file',
  dependencies: [],
  packet: { effect_contract: 'unregistered/effect' },
  postcondition: { verifier: 'file-content-equals/v1', path, content },
};
const eventualWork: Obligation = {
  ...finalWork,
  id: 'eventual-file',
  postcondition: { verifier: 'eventually-consistent-file-content-equals/v1', path, content },
};

function fact(kind: ReceiptKind, observed: Observation | null): ReceiptFact {
  return {
    schema: RECEIPT_SCHEMA,
    run_id: 'run',
    obligation_id: 'final-file',
    claimed_revision: 'revision',
    claim_commit: 'claim',
    execution_generation: 1,
    execution_authority_commit: 'authority',
    kind,
    observed,
    settled_at: settledAt,
    ...(kind === 'source-retry' ? { diagnostic: { source_retry: { reason: 'fixture' } } } : {}),
  };
}

function present(actual = digest): Observation {
  return {
    verifier: 'file-content-equals/v1',
    path,
    expected_sha256: digest,
    actual_sha256: actual,
    mutation_certainty: 'present',
  };
}
function eventualPresent(actual = digest): Observation {
  return {
    verifier: 'eventually-consistent-file-content-equals/v1',
    path,
    expected_sha256: digest,
    actual_sha256: actual,
    mutation_certainty: 'present',
  };
}
function absent(verifier: Observation['verifier'] = 'file-content-equals/v1'): Observation {
  return {
    verifier,
    path,
    expected_sha256: digest,
    mutation_certainty: 'absent',
    absence_evidence: localFileEnoentEvidence(path),
  } as Observation;
}
function uncertain(verifier: Observation['verifier'] = 'file-content-equals/v1'): Observation {
  return {
    verifier,
    path,
    expected_sha256: digest,
    mutation_certainty: 'uncertain',
    observation_error: 'TRANSPORT_AMBIGUOUS',
  } as Observation;
}

function leanBool(value: boolean): string {
  return value ? 'true' : 'false';
}
function leanDisposition(value: ReturnType<typeof projectReceipt>['disposition']): LeanDisposition {
  if (value === 'DONE') return '.done';
  if (value === 'READY') return '.ready';
  if (value === 'RECOVERY_REQUIRED') return '.recoveryRequired';
  if (value === 'WAITING') return '.waiting';
  throw new Error(`UNSUPPORTED_SETTLEMENT_DISPOSITION:${value}`);
}
function leanKind(kind: Exclude<ReceiptKind, 'source-integration'>): LeanKind {
  switch (kind) {
    case 'observation':
      return '.observation';
    case 'judgment-required':
      return '.judgmentRequired';
    case 'execution-terminated':
      return '.executionTerminated';
    case 'effect-not-dispatched':
      return '.effectNotDispatched';
    case 'source-retry':
      return '.sourceRetry';
  }
}

interface Relations {
  assertsPostcondition: boolean;
  supportsAcceptedAbsence: boolean;
  requiresReplaySafety: boolean;
  supportsReplaySafety: boolean;
}

function relations(work: Obligation, observed: Observation, unresolvedEffect: boolean): Relations {
  const asserted = observationVerified(work.postcondition, observed);
  const absence = authoritativeAbsenceEvidence(work.postcondition, observed);
  const policy = settlementSemantics(work.postcondition);
  const accepted =
    absence !== null && policy.acceptedAbsenceEvidenceKinds.includes(absence.kind);
  return {
    assertsPostcondition: asserted,
    supportsAcceptedAbsence: accepted,
    requiresReplaySafety: unresolvedEffect,
    supportsReplaySafety:
      absence !== null && reservedEffectReplaySafe(work, absence),
  };
}

function leanRelations(r: Relations): string {
  return `{ assertsPostcondition := ${leanBool(r.assertsPostcondition)}, supportsAcceptedAbsence := ${leanBool(
    r.supportsAcceptedAbsence,
  )}, requiresReplaySafety := ${leanBool(r.requiresReplaySafety)}, supportsReplaySafety := ${leanBool(
    r.supportsReplaySafety,
  )} }`;
}

const observations = [
  ['final-present', finalWork, present()],
  ['final-corrupt-present', finalWork, present('0'.repeat(64))],
  ['final-absent', finalWork, absent()],
  ['final-uncertain', finalWork, uncertain()],
  ['eventual-present', eventualWork, eventualPresent()],
  ['eventual-corrupt-present', eventualWork, eventualPresent('0'.repeat(64))],
  ['eventual-absent', eventualWork, absent('eventually-consistent-file-content-equals/v1')],
  ['eventual-uncertain', eventualWork, uncertain('eventually-consistent-file-content-equals/v1')],
] as const;

const examples: string[] = [
  'prelude',
  'import Settlement',
  'open Overcenter.Settlement',
  '',
];
let caseCount = 0;

for (const [, work, observed] of observations) {
  for (const unresolvedEffect of [false, true]) {
    const r = relations(work, observed, unresolvedEffect);
    const receipt = projectReceipt(
      fact('observation', observed),
      work,
      undefined,
      unresolvedEffect,
    );
    examples.push(
      `example : settlementDisposition .observation ${leanRelations(r)} false = ${leanDisposition(
        receipt.disposition,
      )} := rfl`,
    );
    caseCount += 1;
  }
}

for (const [kind, release] of [
  ['judgment-required', false],
  ['execution-terminated', false],
  ['effect-not-dispatched', false],
  ['effect-not-dispatched', true],
  ['source-retry', false],
] as const) {
  const receipt = projectReceipt(fact(kind, null), finalWork, undefined, false, release);
  examples.push(
    `example : settlementDisposition ${leanKind(kind)} { assertsPostcondition := false, supportsAcceptedAbsence := false, requiresReplaySafety := false, supportsReplaySafety := false } ${leanBool(
      release,
    )} = ${leanDisposition(receipt.disposition)} := rfl`,
  );
  caseCount += 1;
}

const root = mkdtempSync(join(tmpdir(), 'overcenter-lean-settlement-'));
try {
  const kernel = join(root, 'Settlement.olean');
  let started = performance.now();
  const compiled = spawnSync(LEAN, ['-o', kernel, KERNEL], { encoding: 'utf8' });
  const kernelMs = performance.now() - started;
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout ?? '');
    process.stderr.write(compiled.stderr ?? '');
    throw new Error('LEAN_SETTLEMENT_KERNEL_REJECTED');
  }

  const cases = join(root, 'Cases.lean');
  writeFileSync(cases, `${examples.join('\n')}\n`);
  started = performance.now();
  const exhaustive = spawnSync(LEAN, [cases], {
    encoding: 'utf8',
    env: { ...process.env, LEAN_PATH: root },
  });
  const exhaustiveMs = performance.now() - started;
  if (exhaustive.error) throw exhaustive.error;
  if (exhaustive.status !== 0) {
    process.stderr.write(exhaustive.stdout ?? '');
    process.stderr.write(exhaustive.stderr ?? '');
    throw new Error('LEAN_SETTLEMENT_CASES_REJECTED');
  }

  const hostile = examples.slice();
  const target = hostile.findIndex((line) => line.includes('settlementDisposition .observation'));
  if (target < 0) throw new Error('LEAN_SETTLEMENT_NEGATIVE_CONTROL_MISSING');
  hostile[target] = hostile[target]!.replace('= .done := rfl', '= .ready := rfl');
  const hostileFile = join(root, 'Hostile.lean');
  writeFileSync(hostileFile, `${hostile.join('\n')}\n`);
  started = performance.now();
  const negative = spawnSync(LEAN, [hostileFile], {
    encoding: 'utf8',
    env: { ...process.env, LEAN_PATH: root },
  });
  const negativeMs = performance.now() - started;
  if (negative.error) throw negative.error;
  if (negative.status === 0) throw new Error('LEAN_SETTLEMENT_NEGATIVE_CONTROL_ACCEPTED');

  console.log(
    JSON.stringify({
      schema: 'overcenter-lean-settlement/v1',
      production_cases: caseCount,
      production: 'accepted',
      negative_control: 'rejected',
      kernel_ms: Number(kernelMs.toFixed(3)),
      cases_ms: Number(exhaustiveMs.toFixed(3)),
      negative_control_ms: Number(negativeMs.toFixed(3)),
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
