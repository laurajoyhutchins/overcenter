import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { OvercenterKernel } from '../../src/authority/kernel.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, 'SettlementTemporal.tla');
const JAR = process.env.TLA2TOOLS_JAR;
if (!JAR) throw new Error('TLA2TOOLS_JAR_REQUIRED');

function kernelFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `overcenter-settlement-${name}-`));
  const path = join(root, 'target.txt');
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  kernel.initialize();
  kernel.define({
    id: 'work',
    dependencies: [],
    packet: { effect_contract: 'fixture-effect/v1' },
    postcondition: { verifier: 'file-content-equals/v1', path, content: 'expected' },
  });
  const ready = kernel.deriveReadyWork();
  assert.ok(ready);
  const permit = kernel.claim(ready.id, ready.revision);
  return { root, path, kernel, permit };
}

function probeProduction() {
  const present = kernelFixture('present');
  let doneClears = false;
  let terminalIdempotent = false;
  try {
    present.kernel.beginEffect(present.permit);
    writeFileSync(present.path, 'expected');
    const first = present.kernel.resolve(present.permit);
    const beforeCount = present.kernel.receipts(present.permit.id).length;
    const second = present.kernel.resolve(present.permit);
    const afterCount = present.kernel.receipts(present.permit.id).length;
    doneClears =
      first.disposition === 'DONE' &&
      !present.kernel.hasUnresolvedEffect(present.permit.id);
    terminalIdempotent =
      second.disposition === 'DONE' &&
      beforeCount === 1 &&
      afterCount === 1 &&
      second.settlement_commit === first.settlement_commit;
  } finally {
    present.kernel.close();
    rmSync(present.root, { recursive: true, force: true });
  }

  const recovery = kernelFixture('recovery');
  let recoveryPreserves = false;
  try {
    recovery.kernel.beginEffect(recovery.permit);
    const receipt = recovery.kernel.resolve(recovery.permit);
    recoveryPreserves =
      receipt.disposition === 'RECOVERY_REQUIRED' &&
      recovery.kernel.hasUnresolvedEffect(recovery.permit.id);
  } finally {
    recovery.kernel.close();
    rmSync(recovery.root, { recursive: true, force: true });
  }

  const absent = kernelFixture('absent');
  let absentWithoutReservationReady = false;
  try {
    const receipt = absent.kernel.resolve(absent.permit);
    absentWithoutReservationReady =
      receipt.disposition === 'READY' &&
      !absent.kernel.hasUnresolvedEffect(absent.permit.id);
  } finally {
    absent.kernel.close();
    rmSync(absent.root, { recursive: true, force: true });
  }

  return {
    clearOnTerminal: doneClears,
    preserveOnRecovery: recoveryPreserves,
    blockAfterTerminal: terminalIdempotent,
    absentWithoutReservationReady,
  };
}

function bool(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

function config(values: ReturnType<typeof probeProduction>): string {
  return `CONSTANTS
  ClearOnTerminal = ${bool(values.clearOnTerminal)}
  PreserveOnRecovery = ${bool(values.preserveOnRecovery)}
  BlockAfterTerminal = ${bool(values.blockAfterTerminal)}
  AbsentWithoutReservationReady = ${bool(values.absentWithoutReservationReady)}

SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT TerminalClearsReservation
INVARIANT RecoveryPreservesReservation
INVARIANT TerminalFinality
INVARIANT NoFalseDone
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

function runTlc(values: ReturnType<typeof probeProduction>): Result {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-tlc-settlement-'));
  try {
    writeFileSync(join(root, 'SettlementTemporal.tla'), readFileSync(MODEL));
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
        'SettlementTemporal.tla',
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

const production = probeProduction();
if (Object.values(production).some((value) => !value)) {
  throw new Error(`TLA_SETTLEMENT_PRODUCTION_PROBE_FAILED:${JSON.stringify(production)}`);
}

const accepted = runTlc(production);
if (
  accepted.status !== 0 ||
  !accepted.output.includes('Model checking completed. No error has been found.')
) {
  process.stderr.write(accepted.output);
  throw new Error('TLA_SETTLEMENT_PRODUCTION_MODEL_REJECTED');
}

const clearNegative = runTlc({ ...production, clearOnTerminal: false });
if (
  clearNegative.status === 0 ||
  !clearNegative.output.includes('Invariant TerminalClearsReservation is violated')
) {
  process.stderr.write(clearNegative.output);
  throw new Error('TLA_SETTLEMENT_CLEAR_NEGATIVE_CONTROL_FAILED');
}

const preserveNegative = runTlc({ ...production, preserveOnRecovery: false });
if (
  preserveNegative.status === 0 ||
  !preserveNegative.output.includes('Invariant RecoveryPreservesReservation is violated')
) {
  process.stderr.write(preserveNegative.output);
  throw new Error('TLA_SETTLEMENT_RECOVERY_NEGATIVE_CONTROL_FAILED');
}

const terminalNegative = runTlc({ ...production, blockAfterTerminal: false });
if (
  terminalNegative.status === 0 ||
  !terminalNegative.output.includes('Invariant TerminalFinality is violated')
) {
  process.stderr.write(terminalNegative.output);
  throw new Error('TLA_SETTLEMENT_TERMINAL_NEGATIVE_CONTROL_FAILED');
}

console.log(
  JSON.stringify({
    schema: 'overcenter-tla-settlement/v1',
    production_guards: production,
    production: {
      result: 'accepted',
      elapsed_ms: accepted.elapsed_ms,
      states_generated: accepted.states_generated,
      distinct_states: accepted.distinct_states,
    },
    negative_controls: {
      terminal_clear: {
        result: 'rejected',
        invariant: 'TerminalClearsReservation',
        elapsed_ms: clearNegative.elapsed_ms,
      },
      recovery_preservation: {
        result: 'rejected',
        invariant: 'RecoveryPreservesReservation',
        elapsed_ms: preserveNegative.elapsed_ms,
      },
      terminal_finality: {
        result: 'rejected',
        invariant: 'TerminalFinality',
        elapsed_ms: terminalNegative.elapsed_ms,
      },
    },
  }),
);
