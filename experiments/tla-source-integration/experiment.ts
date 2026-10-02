import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../../src/effect-adapter.ts';
import {
  sourceIntegrationSettlementError,
  type SourceIntegrationEvidence,
} from '../../src/source/source-integration.ts';
import type { Obligation, Run } from '../../src/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, 'SourceIntegrationTemporal.tla');
const JAR = process.env.TLA2TOOLS_JAR;
if (!JAR) throw new Error('TLA2TOOLS_JAR_REQUIRED');

const run: Run = {
  id: 'run-current',
  obligation_id: 'source',
  claimed_revision: 'revision-current',
  claim_commit: 'claim-current',
  obligation_key: 'key-current',
  execution_generation: 1,
  execution_authority_commit: 'authority-current',
  execution_capability_sha256: 'capability-current',
  source_revision: 'a'.repeat(40),
};

const validWork: Obligation = {
  id: 'source',
  dependencies: [],
  packet: {
    kind: 'source-change',
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
  },
  postcondition: { verifier: 'source-integration/v1' },
};

const validEvidence: Pick<
  SourceIntegrationEvidence,
  'run_id' | 'obligation_key' | 'source_sha'
> = {
  run_id: run.id,
  obligation_key: run.obligation_key,
  source_sha: run.source_revision!,
};

function retryFixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `overcenter-source-retry-${name}-`));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  kernel.initialize();
  kernel.define(validWork);
  const ready = kernel.deriveReadyWork();
  if (!ready) throw new Error('TLA_SOURCE_RETRY_NOT_READY');
  const claimed = kernel.claim(ready.id, ready.revision, {
    sourceRevision: run.source_revision!,
  });
  const permit = kernel.acquireExecution(claimed.id);
  return {
    root,
    kernel,
    permit,
    close() {
      kernel.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function productionGuards() {
  const valid = sourceIntegrationSettlementError(run, validWork, validEvidence, true);
  const noReservation = sourceIntegrationSettlementError(run, validWork, validEvidence, false);
  const invalidWork = sourceIntegrationSettlementError(
    run,
    { ...validWork, packet: { kind: 'other', effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT } },
    validEvidence,
    true,
  );
  const invalidBinding = sourceIntegrationSettlementError(
    run,
    validWork,
    { ...validEvidence, source_sha: 'b'.repeat(40) },
    true,
  );

  let retryWithoutReservation = false;
  {
    const f = retryFixture('clear');
    try {
      const receipt = f.kernel.retrySourceIntegration(f.permit, 'retry-safe');
      retryWithoutReservation = receipt.disposition === 'READY';
    } finally {
      f.close();
    }
  }

  let retryBlockedWithReservation = false;
  {
    const f = retryFixture('reserved');
    try {
      f.kernel.beginEffect(f.permit);
      try {
        f.kernel.retrySourceIntegration(f.permit, 'must-not-retry');
      } catch (error: unknown) {
        retryBlockedWithReservation =
          error instanceof Error && error.message === 'SOURCE_RETRY_WITH_UNRESOLVED_EFFECT';
      }
    } finally {
      f.close();
    }
  }

  return {
    requireReservation:
      valid === null &&
      noReservation === 'SOURCE_SETTLEMENT_WITHOUT_RESERVED_EFFECT',
    requireWorkShape:
      valid === null &&
      invalidWork === 'SOURCE_SETTLEMENT_WORK_INVALID',
    requireBinding:
      valid === null &&
      invalidBinding === 'SOURCE_INTEGRATION_EVIDENCE_BINDING_MISMATCH',
    retryRequiresClear: retryWithoutReservation && retryBlockedWithReservation,
  };
}

function bool(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

function config(values: ReturnType<typeof productionGuards>): string {
  return `CONSTANTS
  RequireReservation = ${bool(values.requireReservation)}
  RequireWorkShape = ${bool(values.requireWorkShape)}
  RequireBinding = ${bool(values.requireBinding)}
  RetryRequiresClear = ${bool(values.retryRequiresClear)}

SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT NoUnsafeSourceAction
INVARIANT TerminalChoice
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
  const root = mkdtempSync(join(tmpdir(), 'overcenter-tlc-source-integration-'));
  try {
    writeFileSync(join(root, 'SourceIntegrationTemporal.tla'), readFileSync(MODEL));
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
        'SourceIntegrationTemporal.tla',
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
  throw new Error(`TLA_SOURCE_INTEGRATION_PRODUCTION_PROBE_FAILED:${JSON.stringify(production)}`);
}

const accepted = runTlc(production);
if (
  accepted.status !== 0 ||
  !accepted.output.includes('Model checking completed. No error has been found.')
) {
  process.stderr.write(accepted.output);
  throw new Error('TLA_SOURCE_INTEGRATION_PRODUCTION_MODEL_REJECTED');
}

const controls = [
  ['reservation', { ...production, requireReservation: false }],
  ['work-shape', { ...production, requireWorkShape: false }],
  ['binding', { ...production, requireBinding: false }],
  ['retry-clear', { ...production, retryRequiresClear: false }],
] as const;

const negativeControls: Record<string, { result: 'rejected'; elapsed_ms: number }> = {};
for (const [name, values] of controls) {
  const result = runTlc(values);
  if (
    result.status === 0 ||
    !result.output.includes('Invariant NoUnsafeSourceAction is violated')
  ) {
    process.stderr.write(result.output);
    throw new Error(`TLA_SOURCE_INTEGRATION_NEGATIVE_CONTROL_FAILED:${name}`);
  }
  negativeControls[name] = { result: 'rejected', elapsed_ms: result.elapsed_ms };
}

console.log(
  JSON.stringify({
    schema: 'overcenter-tla-source-integration/v1',
    production_guards: production,
    production: {
      result: 'accepted',
      elapsed_ms: accepted.elapsed_ms,
      states_generated: accepted.states_generated,
      distinct_states: accepted.distinct_states,
    },
    negative_controls: negativeControls,
  }),
);
