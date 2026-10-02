import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  EXECUTION_AUTHORITY_SCHEMA,
  RECEIPT_SCHEMA,
  type ExecutionAuthorityFact,
  type ReceiptFact,
} from '../../src/authority/facts.ts';
import {
  executionAuthorityAdvanceError,
  receiptAuthorityError,
} from '../../src/authority/transaction-admission.ts';
import type { Run } from '../../src/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEAN = process.env.LEAN_AUTHORITY_COORDINATE_BIN ?? 'lean';
const KERNEL = resolve(HERE, 'AuthorityCoordinate.lean');

const run: Run = {
  id: 'run-current',
  obligation_id: 'obligation-current',
  claimed_revision: 'revision-current',
  claim_commit: 'claim-current',
  obligation_key: 'key-current',
  execution_generation: 7,
  execution_authority_commit: 'authority-current',
  execution_capability_sha256: 'capability-current',
};

function bit(mask: number, index: number): boolean {
  return (mask & (1 << index)) !== 0;
}
function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

function advanceFact(mask: number): ExecutionAuthorityFact {
  return {
    schema: EXECUTION_AUTHORITY_SCHEMA,
    run_id: bit(mask, 0) ? run.id : 'run-other',
    obligation_id: bit(mask, 1) ? run.obligation_id : 'obligation-other',
    generation: bit(mask, 2) ? run.execution_generation + 1 : run.execution_generation,
    previous_authority_commit: bit(mask, 3)
      ? run.execution_authority_commit
      : 'authority-other',
    execution_capability_sha256: 'capability-next',
  };
}

function leanAdvanceError(value: ReturnType<typeof executionAuthorityAdvanceError>): string {
  if (value === null) return '.ok';
  if (value === 'EXECUTION_AUTHORITY_RUN_MISMATCH') return '.runMismatch';
  if (value === 'EXECUTION_AUTHORITY_OBLIGATION_MISMATCH') return '.obligationMismatch';
  if (value === 'EXECUTION_GENERATION_NOT_SUCCESSOR') return '.generationNotSuccessor';
  if (value === 'EXECUTION_AUTHORITY_PREDECESSOR_MISMATCH') return '.predecessorMismatch';
  throw new Error(`UNKNOWN_ADVANCE_ERROR:${value}`);
}

function receiptFact(mask: number): ReceiptFact {
  return {
    schema: RECEIPT_SCHEMA,
    run_id: bit(mask, 0) ? run.id : 'run-other',
    obligation_id: bit(mask, 1) ? run.obligation_id : 'obligation-other',
    claimed_revision: bit(mask, 2) ? run.claimed_revision : 'revision-other',
    claim_commit: bit(mask, 3) ? run.claim_commit : 'claim-other',
    execution_generation: bit(mask, 4)
      ? run.execution_generation
      : run.execution_generation - 1,
    execution_authority_commit: bit(mask, 5)
      ? run.execution_authority_commit
      : 'authority-other',
    kind: 'judgment-required',
    observed: null,
    settled_at: '2026-10-01T00:00:00.000Z',
  };
}

function leanReceiptError(value: ReturnType<typeof receiptAuthorityError>): string {
  if (value === null) return '.ok';
  if (value === 'RECEIPT_RUN_MISMATCH') return '.runMismatch';
  if (value === 'RECEIPT_OBLIGATION_MISMATCH') return '.obligationMismatch';
  if (value === 'RECEIPT_REVISION_MISMATCH') return '.revisionMismatch';
  if (value === 'RECEIPT_CLAIM_MISMATCH') return '.claimMismatch';
  if (value === 'RECEIPT_EXECUTION_AUTHORITY_MISMATCH') return '.executionAuthorityMismatch';
  throw new Error(`UNKNOWN_RECEIPT_ERROR:${value}`);
}

const examples: string[] = [
  'prelude',
  'import AuthorityCoordinate',
  'open Overcenter.AuthorityCoordinate',
  '',
];

for (let mask = 0; mask < 16; mask += 1) {
  const expected = leanAdvanceError(executionAuthorityAdvanceError(run, advanceFact(mask)));
  examples.push(
    `example : advanceError { run := ${bool(bit(mask, 0))}, obligation := ${bool(
      bit(mask, 1),
    )}, successorGeneration := ${bool(bit(mask, 2))}, predecessorAuthority := ${bool(
      bit(mask, 3),
    )} } = ${expected} := rfl`,
  );
}

for (let mask = 0; mask < 64; mask += 1) {
  const expected = leanReceiptError(receiptAuthorityError(run, receiptFact(mask)));
  examples.push(
    `example : receiptError { run := ${bool(bit(mask, 0))}, obligation := ${bool(
      bit(mask, 1),
    )}, revision := ${bool(bit(mask, 2))}, claim := ${bool(
      bit(mask, 3),
    )}, generation := ${bool(bit(mask, 4))}, authorityCommit := ${bool(
      bit(mask, 5),
    )} } = ${expected} := rfl`,
  );
}

const root = mkdtempSync(join(tmpdir(), 'overcenter-lean-authority-coordinate-'));
try {
  const kernelOut = join(root, 'AuthorityCoordinate.olean');
  let started = performance.now();
  const compiled = spawnSync(LEAN, ['-o', kernelOut, KERNEL], { encoding: 'utf8' });
  const kernelMs = performance.now() - started;
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout ?? '');
    process.stderr.write(compiled.stderr ?? '');
    throw new Error('LEAN_AUTHORITY_COORDINATE_KERNEL_REJECTED');
  }

  const source = `${examples.join('\n')}\n`;
  const casesFile = join(root, 'Cases.lean');
  writeFileSync(casesFile, source);
  started = performance.now();
  const checked = spawnSync(LEAN, [casesFile], {
    encoding: 'utf8',
    env: { ...process.env, LEAN_PATH: root },
  });
  const casesMs = performance.now() - started;
  if (checked.error) throw checked.error;
  if (checked.status !== 0) {
    process.stderr.write(checked.stdout ?? '');
    process.stderr.write(checked.stderr ?? '');
    throw new Error('LEAN_AUTHORITY_COORDINATE_CASES_REJECTED');
  }

  const hostile = source.replace(
    '= .ok := rfl',
    '= .predecessorMismatch := rfl',
  );
  if (hostile === source) throw new Error('LEAN_AUTHORITY_COORDINATE_NEGATIVE_CONTROL_MISSING');
  const hostileFile = join(root, 'Hostile.lean');
  writeFileSync(hostileFile, hostile);
  started = performance.now();
  const rejected = spawnSync(LEAN, [hostileFile], {
    encoding: 'utf8',
    env: { ...process.env, LEAN_PATH: root },
  });
  const negativeMs = performance.now() - started;
  if (rejected.error) throw rejected.error;
  if (rejected.status === 0) throw new Error('LEAN_AUTHORITY_COORDINATE_NEGATIVE_CONTROL_ACCEPTED');

  console.log(
    JSON.stringify({
      schema: 'overcenter-lean-authority-coordinate/v1',
      authority_advance_worlds: 16,
      receipt_worlds: 64,
      production: 'accepted',
      negative_control: 'rejected',
      kernel_ms: Number(kernelMs.toFixed(3)),
      cases_ms: Number(casesMs.toFixed(3)),
      negative_control_ms: Number(negativeMs.toFixed(3)),
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
