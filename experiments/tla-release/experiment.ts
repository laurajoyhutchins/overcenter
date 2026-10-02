import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { OvercenterKernel } from '../../src/authority/kernel.ts';
import { GITHUB_COMMIT_STATUS_EFFECT } from '../../src/effect-adapter.ts';
import type {
  EffectAttemptBinding,
  TrustedEffectReleaseWitness,
} from '../../src/effect-release-witness.ts';
import { performGitHubCommitStatusEffect } from '../../src/providers/github/status-effect.ts';
import {
  createGitHubStatusPost,
  githubStatusNotDispatchedWitness,
} from '../../src/providers/github/status-transport.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = resolve(HERE, 'ReleaseTemporal.tla');
const JAR = process.env.TLA2TOOLS_JAR;
if (!JAR) throw new Error('TLA2TOOLS_JAR_REQUIRED');

const COMMIT = 'a'.repeat(40);
const CONTEXT = 'overcenter/proof';

function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), `overcenter-release-${name}-`));
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

function repository() {
  return {
    id: 42,
    node_id: 'R_42',
    full_name: 'acme/widget',
    name: 'widget',
    owner: { login: 'acme' },
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
): Promise<TrustedEffectReleaseWitness> {
  const post = createGitHubStatusPost({
    lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4),
  });
  try {
    await post('token', expectedPath(), expectedBody(), attempt);
  } catch (error: unknown) {
    const witness = githubStatusNotDispatchedWitness(error);
    if (witness) return witness;
    throw error;
  }
  throw new Error('TLA_RELEASE_WITNESS_EXPECTED_PRECONNECT_FAILURE');
}

async function productionGuards() {
  let clearOnRelease = false;
  {
    const f = fixture('clear');
    try {
      const post = createGitHubStatusPost({
        lookup: (_hostname, _options, callback) => callback(null, '127.0.0.1', 4),
      });
      await assert.rejects(
        performGitHubCommitStatusEffect(f.kernel, f.permit, {
          token: 'token',
          get: async () => repository(),
          post,
          clock: () => '2026-10-01T00:00:00.000Z',
        }),
        /GITHUB_STATUS_MUTATION_NOT_DISPATCHED/,
      );
      clearOnRelease = !f.kernel.hasUnresolvedEffect(f.permit.id);
    } finally {
      f.close();
    }
  }

  let blockPossibleDispatchRelease = false;
  {
    const f = fixture('ambiguous');
    try {
      await assert.rejects(
        performGitHubCommitStatusEffect(f.kernel, f.permit, {
          token: 'token',
          get: async () => repository(),
          post: async () => {
            throw new Error('GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN:ECONNRESET');
          },
          clock: () => '2026-10-01T00:00:00.000Z',
        }),
        /GITHUB_STATUS_MUTATION_TRANSPORT_UNCERTAIN/,
      );
      blockPossibleDispatchRelease = f.kernel.hasUnresolvedEffect(f.permit.id);
    } finally {
      f.close();
    }
  }

  let requireExactBinding = false;
  {
    const f = fixture('binding');
    try {
      const authority = f.kernel.authorizeEffect(f.permit, GITHUB_COMMIT_STATUS_EFFECT);
      const reservation = f.kernel.beginEffect(f.permit);
      const attempt: EffectAttemptBinding = {
        run_id: 'run-other',
        obligation_id: f.permit.obligation_id,
        execution_generation: f.permit.execution_generation,
        execution_authority_commit: f.permit.execution_authority_commit,
        reservation_commit: reservation,
        effect_contract: GITHUB_COMMIT_STATUS_EFFECT,
      };
      const witness = await trustedWitness(attempt);
      assert.throws(
        () => f.kernel.releaseEffectReservation(authority, witness),
        /EFFECT_RELEASE_EVIDENCE_BINDING_MISMATCH/,
      );
      requireExactBinding = f.kernel.hasUnresolvedEffect(f.permit.id);
    } finally {
      f.close();
    }
  }

  return { clearOnRelease, blockPossibleDispatchRelease, requireExactBinding };
}

function bool(value: boolean): string {
  return value ? 'TRUE' : 'FALSE';
}

function config(values: Awaited<ReturnType<typeof productionGuards>>): string {
  return `CONSTANTS
  ClearOnRelease = ${bool(values.clearOnRelease)}
  BlockPossibleDispatchRelease = ${bool(values.blockPossibleDispatchRelease)}
  RequireExactBinding = ${bool(values.requireExactBinding)}

SPECIFICATION Spec
INVARIANT TypeOK
INVARIANT NoUnsafeRelease
INVARIANT ReleasedClearsReservation
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

function runTlc(values: Awaited<ReturnType<typeof productionGuards>>): Result {
  const root = mkdtempSync(join(tmpdir(), 'overcenter-tlc-release-'));
  try {
    writeFileSync(join(root, 'ReleaseTemporal.tla'), readFileSync(MODEL));
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
        'ReleaseTemporal.tla',
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

const production = await productionGuards();
if (Object.values(production).some((value) => !value)) {
  throw new Error(`TLA_RELEASE_PRODUCTION_PROBE_FAILED:${JSON.stringify(production)}`);
}

const accepted = runTlc(production);
if (
  accepted.status !== 0 ||
  !accepted.output.includes('Model checking completed. No error has been found.')
) {
  process.stderr.write(accepted.output);
  throw new Error('TLA_RELEASE_PRODUCTION_MODEL_REJECTED');
}

const clearNegative = runTlc({ ...production, clearOnRelease: false });
if (
  clearNegative.status === 0 ||
  !clearNegative.output.includes('Invariant ReleasedClearsReservation is violated')
) {
  process.stderr.write(clearNegative.output);
  throw new Error('TLA_RELEASE_CLEAR_NEGATIVE_CONTROL_FAILED');
}

const possibleNegative = runTlc({ ...production, blockPossibleDispatchRelease: false });
if (
  possibleNegative.status === 0 ||
  !possibleNegative.output.includes('Invariant NoUnsafeRelease is violated')
) {
  process.stderr.write(possibleNegative.output);
  throw new Error('TLA_RELEASE_POSSIBLE_DISPATCH_NEGATIVE_CONTROL_FAILED');
}

const bindingNegative = runTlc({ ...production, requireExactBinding: false });
if (
  bindingNegative.status === 0 ||
  !bindingNegative.output.includes('Invariant NoUnsafeRelease is violated')
) {
  process.stderr.write(bindingNegative.output);
  throw new Error('TLA_RELEASE_BINDING_NEGATIVE_CONTROL_FAILED');
}

console.log(
  JSON.stringify({
    schema: 'overcenter-tla-release/v1',
    production_guards: production,
    production: {
      result: 'accepted',
      elapsed_ms: accepted.elapsed_ms,
      states_generated: accepted.states_generated,
      distinct_states: accepted.distinct_states,
    },
    negative_controls: {
      release_must_clear: {
        result: 'rejected',
        invariant: 'ReleasedClearsReservation',
        elapsed_ms: clearNegative.elapsed_ms,
      },
      possible_dispatch_cannot_release: {
        result: 'rejected',
        invariant: 'NoUnsafeRelease',
        elapsed_ms: possibleNegative.elapsed_ms,
      },
      binding_must_match: {
        result: 'rejected',
        invariant: 'NoUnsafeRelease',
        elapsed_ms: bindingNegative.elapsed_ms,
      },
    },
  }),
);
