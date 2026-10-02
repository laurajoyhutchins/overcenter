import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../../src/effect-adapter.ts';
import {
  sourceIntegrationSettlementError,
  type SourceIntegrationEvidence,
} from '../../src/source/source-integration.ts';
import type { Obligation, Run } from '../../src/model.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEAN = process.env.LEAN_SOURCE_INTEGRATION_BIN ?? 'lean';
const KERNEL = resolve(HERE, 'SourceIntegration.lean');

const run: Run = {
  id: 'run-current',
  obligation_id: 'source',
  claimed_revision: 'revision-current',
  claim_commit: 'claim-current',
  obligation_key: 'key-current',
  execution_generation: 3,
  execution_authority_commit: 'authority-current',
  execution_capability_sha256: 'capability-current',
  source_revision: 'a'.repeat(40),
};

function bit(mask: number, index: number): boolean {
  return (mask & (1 << index)) !== 0;
}
function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

function work(mask: number): Obligation {
  return {
    id: 'source',
    dependencies: [],
    packet: {
      kind: bit(mask, 1) ? 'source-change' : 'other',
      effect_contract: bit(mask, 2) ? GITHUB_SOURCE_INTEGRATION_EFFECT : 'effect-other',
    },
    postcondition: bit(mask, 3)
      ? { verifier: 'source-integration/v1' }
      : { verifier: 'file-content-equals/v1', path: '/tmp/other', content: 'other' },
  };
}

function evidence(mask: number): Pick<
  SourceIntegrationEvidence,
  'run_id' | 'obligation_key' | 'source_sha'
> {
  return {
    run_id: bit(mask, 4) ? run.id : 'run-other',
    obligation_key: bit(mask, 5) ? run.obligation_key : 'key-other',
    source_sha: bit(mask, 6) ? run.source_revision! : 'b'.repeat(40),
  };
}

function leanError(value: ReturnType<typeof sourceIntegrationSettlementError>): string {
  if (value === null) return '.ok';
  if (value === 'SOURCE_SETTLEMENT_WITHOUT_RESERVED_EFFECT') return '.noReservation';
  if (value === 'SOURCE_SETTLEMENT_WORK_INVALID') return '.workInvalid';
  if (value === 'SOURCE_INTEGRATION_EVIDENCE_BINDING_MISMATCH') return '.evidenceMismatch';
  throw new Error(`UNKNOWN_SOURCE_SETTLEMENT_ERROR:${value}`);
}

const examples: string[] = [
  'prelude',
  'import SourceIntegration',
  'open Overcenter.SourceIntegration',
  '',
];

for (let mask = 0; mask < 128; mask += 1) {
  const expected = leanError(
    sourceIntegrationSettlementError(run, work(mask), evidence(mask), bit(mask, 0)),
  );
  examples.push(
    `example : settlementError { unresolvedEffect := ${bool(bit(mask, 0))}, sourceWork := ${bool(
      bit(mask, 1),
    )}, sourceEffect := ${bool(bit(mask, 2))}, sourceVerifier := ${bool(
      bit(mask, 3),
    )}, run := ${bool(bit(mask, 4))}, obligationKey := ${bool(
      bit(mask, 5),
    )}, sourceRevision := ${bool(bit(mask, 6))} } = ${expected} := rfl`,
  );
}

const root = mkdtempSync(join(tmpdir(), 'overcenter-lean-source-integration-'));
try {
  const kernelOut = join(root, 'SourceIntegration.olean');
  let started = performance.now();
  const compiled = spawnSync(LEAN, ['-o', kernelOut, KERNEL], { encoding: 'utf8' });
  const kernelMs = performance.now() - started;
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout ?? '');
    process.stderr.write(compiled.stderr ?? '');
    throw new Error('LEAN_SOURCE_INTEGRATION_KERNEL_REJECTED');
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
    throw new Error('LEAN_SOURCE_INTEGRATION_CASES_REJECTED');
  }

  const hostile = source.replace('= .ok := rfl', '= .evidenceMismatch := rfl');
  if (hostile === source) throw new Error('LEAN_SOURCE_INTEGRATION_NEGATIVE_CONTROL_MISSING');
  const hostileFile = join(root, 'Hostile.lean');
  writeFileSync(hostileFile, hostile);
  started = performance.now();
  const rejected = spawnSync(LEAN, [hostileFile], {
    encoding: 'utf8',
    env: { ...process.env, LEAN_PATH: root },
  });
  const negativeMs = performance.now() - started;
  if (rejected.error) throw rejected.error;
  if (rejected.status === 0) throw new Error('LEAN_SOURCE_INTEGRATION_NEGATIVE_CONTROL_ACCEPTED');

  console.log(
    JSON.stringify({
      schema: 'overcenter-lean-source-integration/v1',
      settlement_worlds: 128,
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
