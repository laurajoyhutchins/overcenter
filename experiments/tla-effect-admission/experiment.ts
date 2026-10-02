import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { effectAdmissionDecision } from '../../src/authority/transaction-admission.ts';
import type { ExecutionPermit, Run } from '../../src/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, 'EffectAdmissionTemporal.tla');
const JAR = process.env.TLA2TOOLS_JAR;
if (!JAR) throw new Error('TLA2TOOLS_JAR_REQUIRED');

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

const permit: ExecutionPermit = {
  ...run,
  execution_capability: 'raw-capability',
};

const current = effectAdmissionDecision(
  run,
  permit,
  run.execution_capability_sha256,
  false,
);
if (!current.permits || current.denial !== null) {
  throw new Error('TLA_ADMISSION_BASELINE_NOT_PERMITTED');
}

const stale = effectAdmissionDecision(
  run,
  { ...permit, execution_generation: permit.execution_generation - 1 },
  run.execution_capability_sha256,
  false,
);
const checkFence =
  !stale.permits && stale.denial === 'STALE_EXECUTION_GENERATION';

const unresolved = effectAdmissionDecision(
  run,
  permit,
  run.execution_capability_sha256,
  true,
);
const blockDuplicateReservation =
  !unresolved.permits && unresolved.denial === 'UNRESOLVED_EFFECT';

function config(
  fence: boolean,
  duplicate: boolean,
): string {
  return `CONSTANTS
  W1 = W1
  W2 = W2
  MaxGeneration = 2
  CheckFence = ${fence ? 'TRUE' : 'FALSE'}
  BlockDuplicateReservation = ${duplicate ? 'TRUE' : 'FALSE'}

SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT NoStaleReservation
INVARIANT NoDuplicateReservation
INVARIANT NoDoubleExecution
CHECK_DEADLOCK FALSE
`;
}

interface TlcResult {
  status: number | null;
  output: string;
  elapsed_ms: number;
  states_generated: number | null;
  distinct_states: number | null;
}

function runTlc(fence: boolean, duplicate: boolean): TlcResult {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-tlc-admission-'));
  try {
    const cfg = join(root, 'Model.cfg');
    const model = join(root, 'EffectAdmissionTemporal.tla');
    const meta = join(root, 'states');
    writeFileSync(cfg, config(fence, duplicate));
    writeFileSync(model, readFileSync(MODEL));
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
        meta,
        '-config',
        'Model.cfg',
        'EffectAdmissionTemporal.tla',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    const elapsed_ms = performance.now() - started;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const match = output.match(/(\d+) states generated, (\d+) distinct states found/);
    return {
      status: result.status,
      output,
      elapsed_ms: Number(elapsed_ms.toFixed(3)),
      states_generated: match ? Number(match[1]) : null,
      distinct_states: match ? Number(match[2]) : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const production = runTlc(checkFence, blockDuplicateReservation);
if (
  production.status !== 0 ||
  !production.output.includes('Model checking completed. No error has been found.')
) {
  process.stderr.write(production.output);
  throw new Error('TLA_EFFECT_ADMISSION_PRODUCTION_MODEL_REJECTED');
}

const duplicateNegative = runTlc(checkFence, false);
if (
  duplicateNegative.status === 0 ||
  !duplicateNegative.output.includes('Invariant NoDuplicateReservation is violated')
) {
  process.stderr.write(duplicateNegative.output);
  throw new Error('TLA_EFFECT_ADMISSION_DUPLICATE_NEGATIVE_CONTROL_FAILED');
}

const fenceNegative = runTlc(false, blockDuplicateReservation);
if (
  fenceNegative.status === 0 ||
  !fenceNegative.output.includes('Invariant NoStaleReservation is violated')
) {
  process.stderr.write(fenceNegative.output);
  throw new Error('TLA_EFFECT_ADMISSION_FENCE_NEGATIVE_CONTROL_FAILED');
}

console.log(
  JSON.stringify({
    schema: 'overcenter-tla-effect-admission/v1',
    production_guards: {
      check_fence: checkFence,
      block_duplicate_reservation: blockDuplicateReservation,
    },
    production: {
      result: 'accepted',
      elapsed_ms: production.elapsed_ms,
      states_generated: production.states_generated,
      distinct_states: production.distinct_states,
    },
    negative_controls: {
      duplicate_reservation: {
        result: 'rejected',
        elapsed_ms: duplicateNegative.elapsed_ms,
        invariant: 'NoDuplicateReservation',
      },
      stale_authority: {
        result: 'rejected',
        elapsed_ms: fenceNegative.elapsed_ms,
        invariant: 'NoStaleReservation',
      },
    },
  }),
);
