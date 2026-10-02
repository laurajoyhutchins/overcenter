import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { effectAdmissionDecision } from '../../src/authority/transaction-admission.ts';
import type { ExecutionPermit, Run } from '../../src/model.ts';

interface AdmissionGuards {
  run: boolean;
  obligation: boolean;
  revision: boolean;
  claim: boolean;
  obligationKey: boolean;
  generation: boolean;
  authorityCommit: boolean;
  capabilityBinding: boolean;
  presentedCapability: boolean;
  unresolvedEffect: boolean;
}

interface LeanResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const LEAN = process.env.LEAN_EFFECT_ADMISSION_BIN ?? 'lean';
const KERNEL = resolve(HERE, 'EffectAdmission.lean');
const TRUE_CAPABILITY = 'capability-digest-current';
const CASE_COUNT = 1 << 10;

function runForMask(mask: number): {
  run: Run;
  permit: ExecutionPermit;
  capabilitySha256: string;
  unresolvedEffect: boolean;
} {
  const bit = (index: number) => (mask & (1 << index)) !== 0;
  const run: Run = {
    id: 'run-current',
    obligation_id: 'obligation-current',
    claimed_revision: 'revision-current',
    claim_commit: 'claim-current',
    obligation_key: 'key-current',
    execution_generation: 7,
    execution_authority_commit: 'authority-current',
    execution_capability_sha256: TRUE_CAPABILITY,
  };
  const permit: ExecutionPermit = {
    id: bit(0) ? run.id : 'run-stale',
    obligation_id: bit(1) ? run.obligation_id : 'obligation-stale',
    claimed_revision: bit(2) ? run.claimed_revision : 'revision-stale',
    claim_commit: bit(3) ? run.claim_commit : 'claim-stale',
    obligation_key: bit(4) ? run.obligation_key : 'key-stale',
    execution_generation: bit(5) ? run.execution_generation : run.execution_generation - 1,
    execution_authority_commit: bit(6)
      ? run.execution_authority_commit
      : 'authority-stale',
    execution_capability_sha256: bit(7)
      ? run.execution_capability_sha256
      : 'capability-binding-stale',
    execution_capability: 'raw-capability-not-read-by-admission',
  };
  return {
    run,
    permit,
    capabilitySha256: bit(8) ? run.execution_capability_sha256 : 'presented-capability-stale',
    unresolvedEffect: bit(9),
  };
}

function projectGuards(
  run: Run,
  permit: ExecutionPermit,
  capabilitySha256: string,
  unresolvedEffect: boolean,
): AdmissionGuards {
  return {
    run: permit.id === run.id,
    obligation: permit.obligation_id === run.obligation_id,
    revision: permit.claimed_revision === run.claimed_revision,
    claim: permit.claim_commit === run.claim_commit,
    obligationKey: permit.obligation_key === run.obligation_key,
    generation: permit.execution_generation === run.execution_generation,
    authorityCommit: permit.execution_authority_commit === run.execution_authority_commit,
    capabilityBinding:
      permit.execution_capability_sha256 === run.execution_capability_sha256,
    presentedCapability: capabilitySha256 === run.execution_capability_sha256,
    unresolvedEffect,
  };
}

function leanBool(value: boolean): string {
  return value ? 'true' : 'false';
}

function leanGuards(g: AdmissionGuards): string {
  return `{ run := ${leanBool(g.run)}, obligation := ${leanBool(
    g.obligation,
  )}, revision := ${leanBool(g.revision)}, claim := ${leanBool(
    g.claim,
  )}, obligationKey := ${leanBool(g.obligationKey)}, generation := ${leanBool(
    g.generation,
  )}, authorityCommit := ${leanBool(g.authorityCommit)}, capabilityBinding := ${leanBool(
    g.capabilityBinding,
  )}, presentedCapability := ${leanBool(
    g.presentedCapability,
  )}, unresolvedEffect := ${leanBool(g.unresolvedEffect)} }`;
}

function leanDecision(
  decision: ReturnType<typeof effectAdmissionDecision>,
): '.permits' | '.staleExecution' | '.unresolvedEffect' {
  if (decision.permits) {
    if (decision.denial !== null) throw new Error('LEAN_ORACLE_INVALID_PERMITTED_DENIAL');
    return '.permits';
  }
  if (decision.denial === 'STALE_EXECUTION_GENERATION') return '.staleExecution';
  if (decision.denial === 'UNRESOLVED_EFFECT') return '.unresolvedEffect';
  throw new Error('LEAN_ORACLE_INVALID_DENIAL');
}

function sourceForCases(flipMask: number | null = null): string {
  const examples: string[] = [
    'prelude',
    'import EffectAdmission',
    'open Overcenter.FourByFour',
    '',
  ];
  for (let mask = 0; mask < CASE_COUNT; mask += 1) {
    const { run, permit, capabilitySha256, unresolvedEffect } = runForMask(mask);
    const guards = projectGuards(run, permit, capabilitySha256, unresolvedEffect);
    let expected = leanDecision(
      effectAdmissionDecision(run, permit, capabilitySha256, unresolvedEffect),
    );
    if (mask === flipMask) {
      expected = expected === '.permits' ? '.staleExecution' : '.permits';
    }
    examples.push(
      `example : admissionDecision ${leanGuards(guards)} = ${expected} := rfl`,
    );
  }
  return `${examples.join('\n')}\n`;
}

function runLean(source: string, root: string): LeanResult {
  const cases = join(root, 'Cases.lean');
  writeFileSync(cases, source);
  const result = spawnSync(LEAN, [cases], {
    encoding: 'utf8',
    env: { ...process.env, LEAN_PATH: root },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const root = mkdtempSync(join(tmpdir(), 'overcenter-lean-effect-admission-'));
try {
  const kernelTarget = join(root, 'EffectAdmission.olean');
  const kernelStart = performance.now();
  execFileSync(LEAN, ['-o', kernelTarget, KERNEL], { stdio: 'pipe' });
  const kernelMs = performance.now() - kernelStart;

  const exhaustiveStart = performance.now();
  const exhaustive = runLean(sourceForCases(), root);
  const exhaustiveMs = performance.now() - exhaustiveStart;
  if (exhaustive.status !== 0) {
    process.stderr.write(exhaustive.stdout);
    process.stderr.write(exhaustive.stderr);
    throw new Error('LEAN_EFFECT_ADMISSION_EXHAUSTIVE_REJECTED');
  }

  const permittedMask = (1 << 9) - 1;
  const negativeStart = performance.now();
  const negative = runLean(sourceForCases(permittedMask), root);
  const negativeMs = performance.now() - negativeStart;
  if (negative.status === 0) throw new Error('LEAN_EFFECT_ADMISSION_NEGATIVE_CONTROL_ACCEPTED');
  const negativeOutput = `${negative.stdout}${negative.stderr}`;
  if (!negativeOutput.includes('type mismatch')) {
    throw new Error('LEAN_EFFECT_ADMISSION_NEGATIVE_CONTROL_WRONG_FAILURE');
  }

  console.log(
    JSON.stringify({
      schema: 'overcenter-lean-effect-admission/v1',
      cases: CASE_COUNT,
      exhaustive: 'accepted',
      negative_control: 'rejected',
      kernel_bytes: readFileSync(kernelTarget).byteLength,
      kernel_ms: Number(kernelMs.toFixed(3)),
      exhaustive_ms: Number(exhaustiveMs.toFixed(3)),
      negative_control_ms: Number(negativeMs.toFixed(3)),
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
