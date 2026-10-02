import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import {
  deriveRecoveryPlan,
  possibleEffectWorlds,
  recoveryEventsPermittedInAllWorlds,
  type RecoveryRelations,
} from '../../src/authority/recovery.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, 'RecoveryTemporal.tla');
const JAR = process.env.TLA2TOOLS_JAR;
if (!JAR) throw new Error('TLA2TOOLS_JAR_REQUIRED');

const empty: RecoveryRelations = {
  event_asserts_postcondition: false,
  object_supports_accepted_absence: false,
  object_supports_not_dispatched: false,
  accepted_absence_requires_replay_safety: false,
  object_supports_replay_safety: false,
};
const success: RecoveryRelations = { ...empty, event_asserts_postcondition: true };
const retry: RecoveryRelations = { ...empty, object_supports_not_dispatched: true };

function productionGuards() {
  const ambiguous = deriveRecoveryPlan('coordinate-current', empty);
  const successPlan = deriveRecoveryPlan('coordinate-current', success);
  const retryPlan = deriveRecoveryPlan('coordinate-current', retry);
  if (
    successPlan.preferred !== 'settle' ||
    retryPlan.preferred !== 'retry'
  ) {
    throw new Error('TLA_RECOVERY_TERMINAL_CLASSIFICATION_INVALID');
  }

  const staleRetry = recoveryEventsPermittedInAllWorlds(
    'coordinate-current',
    possibleEffectWorlds('coordinate-old', retry),
  );
  const staleSuccess = recoveryEventsPermittedInAllWorlds(
    'coordinate-current',
    possibleEffectWorlds('coordinate-old', success),
  );

  return {
    protectAmbiguity:
      ambiguous.preferred === 'reconcile' &&
      JSON.stringify(ambiguous.permitted) === JSON.stringify(['reconcile']),
    protectCoordinate:
      JSON.stringify(staleRetry) === JSON.stringify(['reconcile']) &&
      JSON.stringify(staleSuccess) === JSON.stringify(['reconcile']),
  };
}

function bool(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

function config(values: ReturnType<typeof productionGuards>): string {
  return `CONSTANTS
  ProtectAmbiguity = ${bool(values.protectAmbiguity)}
  ProtectCoordinate = ${bool(values.protectCoordinate)}

SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT NoUnsafeRecoveryAction
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
  const root = mkdtempSync(join(tmpdir(), 'overcenter-tlc-recovery-'));
  try {
    writeFileSync(join(root, 'RecoveryTemporal.tla'), readFileSync(MODEL));
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
        'RecoveryTemporal.tla',
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
if (!production.protectAmbiguity || !production.protectCoordinate) {
  throw new Error(`TLA_RECOVERY_PRODUCTION_PROBE_FAILED:${JSON.stringify(production)}`);
}

const accepted = runTlc(production);
if (
  accepted.status !== 0 ||
  !accepted.output.includes('Model checking completed. No error has been found.')
) {
  process.stderr.write(accepted.output);
  throw new Error('TLA_RECOVERY_PRODUCTION_MODEL_REJECTED');
}

const ambiguityNegative = runTlc({ ...production, protectAmbiguity: false });
if (
  ambiguityNegative.status === 0 ||
  !ambiguityNegative.output.includes('Invariant NoUnsafeRecoveryAction is violated')
) {
  process.stderr.write(ambiguityNegative.output);
  throw new Error('TLA_RECOVERY_AMBIGUITY_NEGATIVE_CONTROL_FAILED');
}

const coordinateNegative = runTlc({ ...production, protectCoordinate: false });
if (
  coordinateNegative.status === 0 ||
  !coordinateNegative.output.includes('Invariant NoUnsafeRecoveryAction is violated')
) {
  process.stderr.write(coordinateNegative.output);
  throw new Error('TLA_RECOVERY_COORDINATE_NEGATIVE_CONTROL_FAILED');
}

console.log(
  JSON.stringify({
    schema: 'overcenter-tla-recovery/v1',
    production_guards: production,
    production: {
      result: 'accepted',
      elapsed_ms: accepted.elapsed_ms,
      states_generated: accepted.states_generated,
      distinct_states: accepted.distinct_states,
    },
    negative_controls: {
      ambiguity: {
        result: 'rejected',
        invariant: 'NoUnsafeRecoveryAction',
        elapsed_ms: ambiguityNegative.elapsed_ms,
      },
      stale_coordinate: {
        result: 'rejected',
        invariant: 'NoUnsafeRecoveryAction',
        elapsed_ms: coordinateNegative.elapsed_ms,
      },
    },
  }),
);
