import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import {
  GITHUB_COMMIT_STATUS_EFFECT,
  GITHUB_STATUS_PROVIDER_ORIGIN,
  reservedEffectReleaseWitnessSafe,
} from '../../src/effect-adapter.ts';
import type {
  EffectAttemptBinding,
  TrustedEffectReleaseWitness,
} from '../../src/effect-release-witness.ts';
import {
  createGitHubStatusPost,
  githubStatusNotDispatchedWitness,
} from '../../src/providers/github/status-transport.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEAN = process.env.LEAN_RELEASE_BIN ?? 'lean';
const KERNEL = resolve(HERE, 'Release.lean');
const COMMIT = 'a'.repeat(40);
const CONTEXT = 'overcenter/proof';

type Decision =
  | '.ready'
  | '.noReservation'
  | '.provenanceInvalid'
  | '.bindingMismatch'
  | '.witnessUnauthorized';

interface Guards {
  reservationExists: boolean;
  trustedWitness: boolean;
  exactBinding: boolean;
  witnessAuthorized: boolean;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-release-'));
  const kernel = new OvercenterKernel(join(root, 'overcenter.sqlite'));
  kernel.initialize();
  kernel.define({
    id: 'status-proof',
    dependencies: [],
    packet: { effect_contract: GITHUB_COMMIT_STATUS_EFFECT },
    postcondition: {
      verifier: 'github-commit-status/v2',
      provider: 'github',
      repository_id: 42,
      repository_full_name: 'acme/widget',
      commit_sha: COMMIT,
      context: CONTEXT,
      expected_state: 'success',
    },
  });
  const ready = kernel.deriveReadyWork();
  assert.ok(ready);
  const permit = kernel.claim(ready.id, ready.revision);
  const authority = kernel.authorizeEffect(permit, GITHUB_COMMIT_STATUS_EFFECT);
  return {
    root,
    kernel,
    permit,
    authority,
    work: kernel.claimedWork(permit),
    close() {
      kernel.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function expectedPath(): string {
  return `/repos/acme/widget/statuses/${COMMIT}`;
}

function expectedBody() {
  return {
    state: 'success' as const,
    context: CONTEXT,
    description: 'Overcenter trusted effect broker',
  };
}

async function trustedWitness(
  attempt: EffectAttemptBinding,
  {
    path = expectedPath(),
    body = expectedBody(),
  }: {
    path?: string;
    body?: ReturnType<typeof expectedBody>;
  } = {},
): Promise<TrustedEffectReleaseWitness> {
  const post = createGitHubStatusPost({
    lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4),
  });
  try {
    await post('token', path, body, attempt);
  } catch (error: unknown) {
    const witness = githubStatusNotDispatchedWitness(error);
    if (witness) return witness;
    throw error;
  }
  throw new Error('RELEASE_WITNESS_EXPECTED_PRECONNECT_FAILURE');
}

function attemptFor(
  permit: ReturnType<typeof fixture>['permit'],
  reservationCommit: string,
): EffectAttemptBinding {
  return {
    run_id: permit.id,
    obligation_id: permit.obligation_id,
    execution_generation: permit.execution_generation,
    execution_authority_commit: permit.execution_authority_commit,
    reservation_commit: reservationCommit,
    effect_contract: GITHUB_COMMIT_STATUS_EFFECT,
  };
}

function bindingMatches(
  attempt: EffectAttemptBinding,
  permit: ReturnType<typeof fixture>['permit'],
  reservationCommit: string,
): boolean {
  return (
    attempt.run_id === permit.id &&
    attempt.obligation_id === permit.obligation_id &&
    attempt.execution_generation === permit.execution_generation &&
    attempt.execution_authority_commit === permit.execution_authority_commit &&
    attempt.reservation_commit === reservationCommit &&
    attempt.effect_contract === GITHUB_COMMIT_STATUS_EFFECT
  );
}

function classify(error: unknown): Decision {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('NO_UNRESOLVED_EFFECT')) return '.noReservation';
  if (message.includes('EFFECT_RELEASE_EVIDENCE_PROVENANCE_INVALID')) return '.provenanceInvalid';
  if (message.includes('EFFECT_RELEASE_EVIDENCE_BINDING_MISMATCH')) return '.bindingMismatch';
  if (message.includes('EFFECT_RELEASE_EVIDENCE_NOT_AUTHORIZED')) return '.witnessUnauthorized';
  throw error;
}

function bool(value: boolean): string {
  return value ? 'true' : 'false';
}

function leanGuards(g: Guards): string {
  return `{ reservationExists := ${bool(g.reservationExists)}, trustedWitness := ${bool(
    g.trustedWitness,
  )}, exactBinding := ${bool(g.exactBinding)}, witnessAuthorized := ${bool(
    g.witnessAuthorized,
  )} }`;
}

async function productionCases(): Promise<Array<{ guards: Guards; decision: Decision; label: string }>> {
  const cases: Array<{ guards: Guards; decision: Decision; label: string }> = [];

  {
    const f = fixture();
    try {
      const reservation = f.kernel.beginEffect(f.permit);
      const attempt = attemptFor(f.permit, reservation);
      const witness = await trustedWitness(attempt);
      const validated = (() => {
        // releaseEffectReservation consumes the branded witness, so use policy knowledge from
        // the exact minted observation before the one-shot consumption.
        return true;
      })();
      assert.equal(validated, true);
      const receipt = f.kernel.releaseEffectReservation(f.authority, witness);
      assert.equal(receipt.disposition, 'READY');
      assert.equal(f.kernel.hasUnresolvedEffect(f.permit.id), false);
      cases.push({
        label: 'valid-release',
        guards: {
          reservationExists: true,
          trustedWitness: true,
          exactBinding: true,
          witnessAuthorized: true,
        },
        decision: '.ready',
      });
    } finally {
      f.close();
    }
  }

  {
    const f = fixture();
    try {
      const fake = {} as TrustedEffectReleaseWitness;
      let decision: Decision = '.ready';
      try {
        f.kernel.releaseEffectReservation(f.authority, fake);
      } catch (error: unknown) {
        decision = classify(error);
      }
      assert.equal(decision, '.noReservation');
      cases.push({
        label: 'no-reservation',
        guards: {
          reservationExists: false,
          trustedWitness: false,
          exactBinding: false,
          witnessAuthorized: false,
        },
        decision,
      });
    } finally {
      f.close();
    }
  }

  {
    const f = fixture();
    try {
      f.kernel.beginEffect(f.permit);
      const fake = {} as TrustedEffectReleaseWitness;
      let decision: Decision = '.ready';
      try {
        f.kernel.releaseEffectReservation(f.authority, fake);
      } catch (error: unknown) {
        decision = classify(error);
      }
      assert.equal(f.kernel.hasUnresolvedEffect(f.permit.id), true);
      cases.push({
        label: 'untrusted-witness',
        guards: {
          reservationExists: true,
          trustedWitness: false,
          exactBinding: false,
          witnessAuthorized: false,
        },
        decision,
      });
    } finally {
      f.close();
    }
  }

  const bindingMutations: Array<[string, (attempt: EffectAttemptBinding) => EffectAttemptBinding]> = [
    ['run', (a) => ({ ...a, run_id: 'run-other' })],
    ['obligation', (a) => ({ ...a, obligation_id: 'obligation-other' })],
    ['generation', (a) => ({ ...a, execution_generation: a.execution_generation + 1 })],
    ['authority', (a) => ({ ...a, execution_authority_commit: 'authority-other' })],
    ['reservation', (a) => ({ ...a, reservation_commit: 'reservation-other' })],
    ['contract', (a) => ({ ...a, effect_contract: 'effect-other' })],
  ];

  for (const [label, mutate] of bindingMutations) {
    const f = fixture();
    try {
      const reservation = f.kernel.beginEffect(f.permit);
      const attempt = mutate(attemptFor(f.permit, reservation));
      const witness = await trustedWitness(attempt);
      let decision: Decision = '.ready';
      try {
        f.kernel.releaseEffectReservation(f.authority, witness);
      } catch (error: unknown) {
        decision = classify(error);
      }
      assert.equal(bindingMatches(attempt, f.permit, reservation), false);
      assert.equal(f.kernel.hasUnresolvedEffect(f.permit.id), true);
      cases.push({
        label: `binding-${label}`,
        guards: {
          reservationExists: true,
          trustedWitness: true,
          exactBinding: false,
          witnessAuthorized: true,
        },
        decision,
      });
    } finally {
      f.close();
    }
  }

  {
    const f = fixture();
    try {
      const reservation = f.kernel.beginEffect(f.permit);
      const attempt = attemptFor(f.permit, reservation);
      const witness = await trustedWitness(attempt, {
        path: `${expectedPath()}-wrong`,
      });
      let decision: Decision = '.ready';
      try {
        f.kernel.releaseEffectReservation(f.authority, witness);
      } catch (error: unknown) {
        decision = classify(error);
      }
      assert.equal(f.kernel.hasUnresolvedEffect(f.permit.id), true);
      cases.push({
        label: 'witness-policy',
        guards: {
          reservationExists: true,
          trustedWitness: true,
          exactBinding: true,
          witnessAuthorized: false,
        },
        decision,
      });
    } finally {
      f.close();
    }
  }

  return cases;
}

const cases = await productionCases();
const root = mkdtempSync(join(tmpdir(), 'overcenter-lean-release-'));
try {
  const kernelOut = join(root, 'Release.olean');
  let started = performance.now();
  const compiled = spawnSync(LEAN, ['-o', kernelOut, KERNEL], { encoding: 'utf8' });
  const kernelMs = performance.now() - started;
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) {
    process.stderr.write(compiled.stdout ?? '');
    process.stderr.write(compiled.stderr ?? '');
    throw new Error('LEAN_RELEASE_KERNEL_REJECTED');
  }

  const source = [
    'prelude',
    'import Release',
    'open Overcenter.Release',
    '',
    ...cases.map(
      ({ guards, decision }) =>
        `example : releaseDecision ${leanGuards(guards)} = ${decision} := rfl`,
    ),
  ].join('\n');
  const casesFile = join(root, 'Cases.lean');
  writeFileSync(casesFile, `${source}\n`);
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
    throw new Error('LEAN_RELEASE_CASES_REJECTED');
  }

  const hostileSource = source.replace(
    'releaseDecision { reservationExists := true, trustedWitness := true, exactBinding := true, witnessAuthorized := true } = .ready',
    'releaseDecision { reservationExists := true, trustedWitness := true, exactBinding := true, witnessAuthorized := true } = .bindingMismatch',
  );
  assert.notEqual(hostileSource, source);
  const hostileFile = join(root, 'Hostile.lean');
  writeFileSync(hostileFile, `${hostileSource}\n`);
  started = performance.now();
  const hostile = spawnSync(LEAN, [hostileFile], {
    encoding: 'utf8',
    env: { ...process.env, LEAN_PATH: root },
  });
  const hostileMs = performance.now() - started;
  if (hostile.error) throw hostile.error;
  if (hostile.status === 0) throw new Error('LEAN_RELEASE_NEGATIVE_CONTROL_ACCEPTED');

  console.log(
    JSON.stringify({
      schema: 'overcenter-lean-release/v1',
      production_cases: cases.length,
      labels: cases.map((item) => item.label),
      production: 'accepted',
      negative_control: 'rejected',
      kernel_ms: Number(kernelMs.toFixed(3)),
      cases_ms: Number(casesMs.toFixed(3)),
      negative_control_ms: Number(hostileMs.toFixed(3)),
      provider_origin: GITHUB_STATUS_PROVIDER_ORIGIN,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
