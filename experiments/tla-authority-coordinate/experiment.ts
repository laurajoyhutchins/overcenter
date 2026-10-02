import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const MODEL = resolve(HERE, 'AuthorityCoordinateTemporal.tla');
const JAR = process.env.TLA2TOOLS_JAR;
if (!JAR) throw new Error('TLA2TOOLS_JAR_REQUIRED');

const run: Run = {
  id: 'run-current',
  obligation_id: 'obligation-current',
  claimed_revision: 'revision-current',
  claim_commit: 'claim-current',
  obligation_key: 'key-current',
  execution_generation: 1,
  execution_authority_commit: 'A0',
  execution_capability_sha256: 'capability-current',
};

function advance(
  generation: number,
  predecessor: string,
): ExecutionAuthorityFact {
  return {
    schema: EXECUTION_AUTHORITY_SCHEMA,
    run_id: run.id,
    obligation_id: run.obligation_id,
    generation,
    previous_authority_commit: predecessor,
    execution_capability_sha256: 'capability-next',
  };
}

function receipt(value: Run): ReceiptFact {
  return {
    schema: RECEIPT_SCHEMA,
    run_id: value.id,
    obligation_id: value.obligation_id,
    claimed_revision: value.claimed_revision,
    claim_commit: value.claim_commit,
    execution_generation: value.execution_generation,
    execution_authority_commit: value.execution_authority_commit,
    kind: 'judgment-required',
    observed: null,
    settled_at: '2026-10-01T00:00:00.000Z',
  };
}

function productionGuards() {
  const goodAdvance = executionAuthorityAdvanceError(run, advance(2, 'A0'));
  const staleGeneration = executionAuthorityAdvanceError(run, advance(1, 'A0'));
  const wrongPredecessor = executionAuthorityAdvanceError(run, advance(2, 'A1'));

  const advanced: Run = {
    ...run,
    execution_generation: 2,
    execution_authority_commit: 'A1',
  };
  const currentReceipt = receiptAuthorityError(advanced, receipt(advanced));
  const oldReceipt = receiptAuthorityError(advanced, receipt(run));

  return {
    requireSuccessor:
      goodAdvance === null &&
      staleGeneration === 'EXECUTION_GENERATION_NOT_SUCCESSOR',
    requirePredecessor:
      goodAdvance === null &&
      wrongPredecessor === 'EXECUTION_AUTHORITY_PREDECESSOR_MISMATCH',
    requireReceiptCurrent:
      currentReceipt === null &&
      oldReceipt === 'RECEIPT_EXECUTION_AUTHORITY_MISMATCH',
  };
}

function bool(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

function config(values: ReturnType<typeof productionGuards>): string {
  return `CONSTANTS
  RequireSuccessor = ${bool(values.requireSuccessor)}
  RequirePredecessor = ${bool(values.requirePredecessor)}
  RequireReceiptCurrent = ${bool(values.requireReceiptCurrent)}

SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT NoBadAdvance
INVARIANT NoStaleReceipt
CHECK_DEADLOCK FALSE
`;
}

interface Result {
  status: number | null;
  output: string;
  elapsed_ms: number;
  states_generated: number | null;
  distinct_states: number | null;
}

function runTlc(values: ReturnType<typeof productionGuards>): Result {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-tlc-authority-coordinate-'));
  try {
    writeFileSync(join(root, 'AuthorityCoordinateTemporal.tla'), readFileSync(MODEL));
    writeFileSync(join(root, 'Model.cfg'), config(values));
    const started = performance.now();
    const result = spawnSync(
      'java',
      [
        '-XX:+UseParallelGC',
        '-cp',
        JAR,
        'tlc2.TLC',
        '-workers',
        '1',
        '-metadir',
        join(root, 'states'),
        '-config',
        'Model.cfg',
        'AuthorityCoordinateTemporal.tla',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const match = output.match(/(\d+) states generated, (\d+) distinct states found/);
    return {
      status: result.status,
      output,
      elapsed_ms: Number((performance.now() - started).toFixed(3)),
      states_generated: match ? Number(match[1]) : null,
      distinct_states: match ? Number(match[2]) : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const production = productionGuards();
if (Object.values(production).some((value) => !value)) {
  throw new Error(`TLA_AUTHORITY_COORDINATE_PRODUCTION_PROBE_FAILED:${JSON.stringify(production)}`);
}

const accepted = runTlc(production);
if (
  accepted.status !== 0 ||
  !accepted.output.includes('Model checking completed. No error has been found.')
) {
  process.stderr.write(accepted.output);
  throw new Error('TLA_AUTHORITY_COORDINATE_PRODUCTION_MODEL_REJECTED');
}

const successorNegative = runTlc({ ...production, requireSuccessor: false });
if (
  successorNegative.status === 0 ||
  !successorNegative.output.includes('Invariant NoBadAdvance is violated')
) {
  process.stderr.write(successorNegative.output);
  throw new Error('TLA_AUTHORITY_COORDINATE_SUCCESSOR_NEGATIVE_CONTROL_FAILED');
}

const predecessorNegative = runTlc({ ...production, requirePredecessor: false });
if (
  predecessorNegative.status === 0 ||
  !predecessorNegative.output.includes('Invariant NoBadAdvance is violated')
) {
  process.stderr.write(predecessorNegative.output);
  throw new Error('TLA_AUTHORITY_COORDINATE_PREDECESSOR_NEGATIVE_CONTROL_FAILED');
}

const receiptNegative = runTlc({ ...production, requireReceiptCurrent: false });
if (
  receiptNegative.status === 0 ||
  !receiptNegative.output.includes('Invariant NoStaleReceipt is violated')
) {
  process.stderr.write(receiptNegative.output);
  throw new Error('TLA_AUTHORITY_COORDINATE_RECEIPT_NEGATIVE_CONTROL_FAILED');
}

console.log(
  JSON.stringify({
    schema: 'overcenter-tla-authority-coordinate/v1',
    production_guards: production,
    production: {
      result: 'accepted',
      elapsed_ms: accepted.elapsed_ms,
      states_generated: accepted.states_generated,
      distinct_states: accepted.distinct_states,
    },
    negative_controls: {
      successor: {
        result: 'rejected',
        invariant: 'NoBadAdvance',
        elapsed_ms: successorNegative.elapsed_ms,
      },
      predecessor: {
        result: 'rejected',
        invariant: 'NoBadAdvance',
        elapsed_ms: predecessorNegative.elapsed_ms,
      },
      stale_receipt: {
        result: 'rejected',
        invariant: 'NoStaleReceipt',
        elapsed_ms: receiptNegative.elapsed_ms,
      },
    },
  }),
);
