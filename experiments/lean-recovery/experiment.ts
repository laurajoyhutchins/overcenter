import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const LEAN = process.env.LEAN_RECOVERY_BIN ?? 'lean';
const KERNEL = resolve(HERE, 'Recovery.lean');
const CURRENT = 'coordinate-current';

type LeanEvent = '.reconcile' | '.retry' | '.settle';

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

function relations(mask: number): RecoveryRelations {
  const bit = (index: number) => (mask & (1 << index)) !== 0;
  return {
    event_asserts_postcondition: bit(0),
    object_supports_accepted_absence: bit(1),
    object_supports_not_dispatched: bit(2),
    accepted_absence_requires_replay_safety: bit(3),
    object_supports_replay_safety: bit(4),
  };
}

function leanRelations(value: RecoveryRelations): string {
  return `{ assertsPostcondition := ${bool(value.event_asserts_postcondition)}, supportsAcceptedAbsence := ${bool(
    value.object_supports_accepted_absence,
  )}, supportsNotDispatched := ${bool(value.object_supports_not_dispatched)}, requiresReplaySafety := ${bool(
    value.accepted_absence_requires_replay_safety,
  )}, supportsReplaySafety := ${bool(value.object_supports_replay_safety)} }`;
}

function leanEvent(value: ReturnType<typeof deriveRecoveryPlan>['preferred']): LeanEvent {
  if (value === 'reconcile') return '.reconcile';
  if (value === 'retry') return '.retry';
  return '.settle';
}

const examples: string[] = [
  'prelude',
  'import Recovery',
  'open Overcenter.Recovery',
  '',
];

for (let mask = 0; mask < 32; mask += 1) {
  const value = relations(mask);
  const plan = deriveRecoveryPlan(CURRENT, value);
  examples.push(
    `example : preferred ${leanRelations(value)} = ${leanEvent(plan.preferred)} := rfl`,
  );
}

for (const value of [
  {
    event_asserts_postcondition: true,
    object_supports_accepted_absence: false,
    object_supports_not_dispatched: false,
    accepted_absence_requires_replay_safety: false,
    object_supports_replay_safety: false,
  },
  {
    event_asserts_postcondition: false,
    object_supports_accepted_absence: false,
    object_supports_not_dispatched: true,
    accepted_absence_requires_replay_safety: false,
    object_supports_replay_safety: false,
  },
] satisfies RecoveryRelations[]) {
  const staleWorlds = possibleEffectWorlds('coordinate-old', value);
  const permitted = recoveryEventsPermittedInAllWorlds(CURRENT, staleWorlds);
  if (JSON.stringify(permitted) !== JSON.stringify(['reconcile'])) {
    throw new Error(`RECOVERY_STALE_COORDINATE_NOT_FAIL_CLOSED:${JSON.stringify(permitted)}`);
  }
  examples.push(
    `example : preferredAtCoordinate false ${leanRelations(value)} = .reconcile := rfl`,
  );
}

const root = mkdtempSync(join(tmpdir(), 'overcenter-lean-recovery-'));
try {
  const kernelOut = join(root, 'Recovery.olean');
  let started = performance.now();
  const compiled = spawnSync(LEAN, ['-o', kernelOut, KERNEL], { encoding: 'utf8' });
  const kernelMs = performance.now() - started;
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout ?? '');
    process.stderr.write(compiled.stderr ?? '');
    throw new Error('LEAN_RECOVERY_KERNEL_REJECTED');
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
    throw new Error('LEAN_RECOVERY_CASES_REJECTED');
  }

  const hostile = source.replace(
    '= .settle := rfl',
    '= .reconcile := rfl',
  );
  if (hostile === source) throw new Error('LEAN_RECOVERY_NEGATIVE_CONTROL_MISSING');
  const hostileFile = join(root, 'Hostile.lean');
  writeFileSync(hostileFile, hostile);
  started = performance.now();
  const rejected = spawnSync(LEAN, [hostileFile], {
    encoding: 'utf8',
    env: { ...process.env, LEAN_PATH: root },
  });
  const negativeMs = performance.now() - started;
  if (rejected.error) throw rejected.error;
  if (rejected.status === 0) throw new Error('LEAN_RECOVERY_NEGATIVE_CONTROL_ACCEPTED');

  console.log(
    JSON.stringify({
      schema: 'overcenter-lean-recovery/v1',
      relation_valuations: 32,
      stale_coordinate_cases: 2,
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
