import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { SqliteFactStore } from './fixtures/sqlite-store.ts';
import { SqliteFactStore as ProductionFactStore } from '../src/storage/sqlite.ts';
import type { DurableFactStore } from '../src/authority/store.ts';
import {
  effectReleaseEvidenceRef,
  type EffectReleaseEvidence,
} from '../src/effect-release-witness.ts';
import {
  createGitHubStatusPost,
  GITHUB_COMMIT_STATUS_EFFECT,
  performGitHubCommitStatusEffect,
} from '../src/providers/github/status-effect.ts';
import { GITHUB_SOURCE_INTEGRATION_EFFECT } from '../src/effect-adapter.ts';
import {
  integrateVerifiedSourceCandidate,
  SOURCE_VERIFICATION_SCHEMA,
} from '../src/source/source-integration.ts';
import { KernelCore, runCoreLoop } from '../src/authority/engine.ts';

function normalize(value: unknown, identities: Map<string, string>): unknown {
  if (typeof value === 'string') return identities.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => normalize(item, identities));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [identities.get(key) ?? key, normalize(item, identities)]),
    );
  }
  return value;
}

function snapshot(kernel: KernelCore, store: DurableFactStore) {
  const head = store.head();
  const facts = head ? store.history(head) : [];
  const identities = new Map<string, string>();
  let runOrdinal = 0;
  for (const [index, fact] of facts.entries()) {
    identities.set(fact.commit, `commit-${index}`);
    const claim = fact.claim as { run_id: string; execution_capability_sha256: string } | null;
    if (claim) {
      const run = `run-${runOrdinal++}`;
      identities.set(claim.run_id, run);
      identities.set(claim.execution_capability_sha256, `${run}-capability-1`);
    }
    const receipt = fact.receipt as {
      diagnostic?: { source_integration?: { integration_commit: string } };
    } | null;
    const integration = receipt?.diagnostic?.source_integration;
    if (integration) identities.set(integration.integration_commit, `source-integration-${index}`);
    const rotation = fact.execution_authority as {
      run_id: string;
      generation: number;
      execution_capability_sha256: string;
    } | null;
    if (rotation)
      identities.set(
        rotation.execution_capability_sha256,
        `${identities.get(rotation.run_id)}-capability-${rotation.generation}`,
      );
  }
  const work = kernel.inspect();
  const normalized = normalize(
    {
      head,
      facts,
      work,
      explanations: work.map((item) => kernel.explain(item.id)),
      receipts: kernel.receipts(),
      unresolved: work.map((item) =>
        item.run_id ? kernel.hasUnresolvedEffect(item.run_id) : false,
      ),
    },
    identities,
  );
  const normalizedFacts = (
    normalized as {
      facts: Array<{
        effect_release: { evidence: EffectReleaseEvidence; evidence_ref: unknown } | null;
      }>;
    }
  ).facts;
  for (const [index, fact] of facts.entries()) {
    const release = fact.effect_release as {
      evidence: EffectReleaseEvidence;
      evidence_ref: unknown;
    } | null;
    if (!release) continue;
    assert.deepEqual(release.evidence_ref, effectReleaseEvidenceRef(release.evidence));
    const normalizedRelease = normalizedFacts[index]!.effect_release!;
    normalizedRelease.evidence_ref = effectReleaseEvidenceRef(normalizedRelease.evidence);
  }
  return normalized;
}

async function exercise(
  kernel: KernelCore,
  store: DurableFactStore,
  firstPath: string,
  secondPath: string,
) {
  kernel.initialize();
  const revision = kernel.head();
  assert.ok(revision);
  kernel.applyGraphPatch(
    {
      upsert: [
        {
          id: 'second',
          dependencies: [{ kind: 'control', upstream: 'first' }],
          packet: { path: secondPath, content: 'B' },
          postcondition: {
            verifier: 'file-content-equals/v1',
            path: secondPath,
            content: 'B',
          },
        },
        {
          id: 'first',
          packet: { path: firstPath, content: 'A' },
          postcondition: {
            verifier: 'file-content-equals/v1',
            path: firstPath,
            content: 'A',
          },
        },
      ],
    },
    revision,
  );

  const before = snapshot(kernel, store);
  assert.throws(() => kernel.applyGraphPatch({ upsert: [] }, revision), /STALE_REVISION/);
  assert.throws(() => kernel.applyGraphPatch({ upsert: [] }, revision), /STALE_REVISION/);
  const ready = kernel.deriveReadyWork();
  assert.ok(ready);
  const first = kernel.claim(ready.id, ready.revision, { sourceRevision: 'a'.repeat(40) });
  const rotated = kernel.acquireExecution(first.id);
  assert.throws(() => kernel.beginEffect(first), /STALE_EXECUTION_GENERATION/);
  kernel.beginEffect(rotated);
  assert.equal(kernel.hasUnresolvedEffect(first.id), true);
  const unresolved = kernel.recoverInterrupted(rotated);
  assert.equal(unresolved.disposition, 'RECOVERY_REQUIRED');
  writeFileSync(firstPath, 'A');
  const recovery = kernel.acquireExecution(first.id);
  assert.equal(kernel.reconcile(recovery).disposition, 'DONE');
  await runCoreLoop(kernel, {
    effect: async (packet) => {
      writeFileSync(String(packet.path), String(packet.content));
      return { kind: 'ok' };
    },
  });
  const sourceRoot = join(
    dirname(firstPath),
    store instanceof SqliteFactStore ? 'sqlite-source' : 'git-source',
  );
  const sourceRepo = join(sourceRoot, 'repo');
  const remote = join(sourceRoot, 'remote.git');
  mkdirSync(sourceRoot);
  const git = (args: string[]) =>
    execFileSync('git', ['-C', sourceRepo, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-09-30T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-09-30T00:00:00Z',
      },
    }).trim();
  execFileSync('git', ['init', '--bare', remote], { stdio: 'ignore' });
  execFileSync('git', ['clone', remote, sourceRepo], { stdio: 'ignore' });
  git(['config', 'user.name', 'Source fixture']);
  git(['config', 'user.email', 'source@local']);
  mkdirSync(join(sourceRepo, 'src'));
  writeFileSync(join(sourceRepo, 'src/tool.ts'), 'export const answer = 1;\n');
  git(['add', '.']);
  git(['commit', '-m', 'initial source']);
  const sourceSha = git(['rev-parse', 'HEAD']);
  git(['push', 'origin', 'HEAD:refs/heads/main']);
  const task = {
    schema: 'overcenter-source-task/v1',
    kind: 'source-change',
    objective: 'change answer',
    writable_paths: ['src/tool.ts'],
    effect_contract: GITHUB_SOURCE_INTEGRATION_EFFECT,
  };
  kernel.define({
    id: 'source',
    packet: task,
    postcondition: { verifier: 'source-integration/v1' },
  });
  const sourceReady = kernel.deriveReadyWork();
  assert.ok(sourceReady);
  const sourceFirst = kernel.claim(sourceReady.id, sourceReady.revision, {
    sourceRevision: sourceSha,
  });
  assert.equal(
    kernel.retrySourceIntegration(sourceFirst, 'candidate must be refreshed').disposition,
    'READY',
  );
  const sourceRetry = kernel.deriveReadyWork();
  assert.ok(sourceRetry);
  const sourceRun = kernel.claim(sourceRetry.id, sourceRetry.revision, {
    sourceRevision: sourceSha,
  });
  writeFileSync(join(sourceRepo, 'src/tool.ts'), 'export const answer = 2;\n');
  git(['add', '.']);
  git(['commit', '-m', 'candidate\n\nOvercenter-Obligation-Id: source']);
  const candidate = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const claim = {
    run_id: sourceRun.id,
    obligation_key: sourceRun.obligation_key,
    claimed_revision: sourceRun.claimed_revision,
    source_sha: sourceSha,
  };
  const authority = kernel.authorizeEffect(sourceRun, GITHUB_SOURCE_INTEGRATION_EFFECT);
  const integrated = integrateVerifiedSourceCandidate(
    sourceRepo,
    task,
    claim,
    'source',
    candidate,
    {
      schema: SOURCE_VERIFICATION_SCHEMA,
      state: 'verified',
      run_id: sourceRun.id,
      candidate_sha: candidate,
      base_sha: sourceSha,
      tree_sha: tree,
      reason: null,
    },
    { performReservedMutation: (mutation) => kernel.performEffectSync(authority, mutation) },
  );
  assert.equal(integrated.state, 'INTEGRATED');
  if (integrated.state !== 'INTEGRATED') throw new Error('SOURCE_FIXTURE_NOT_INTEGRATED');
  assert.equal(kernel.settleSourceIntegration(sourceRun, integrated.witness).disposition, 'DONE');
  kernel.define({
    id: 'release',
    packet: { effect_contract: GITHUB_COMMIT_STATUS_EFFECT },
    postcondition: {
      verifier: 'github-commit-status/v2',
      provider: 'github',
      repository_id: 42,
      repository_full_name: 'acme/widget',
      commit_sha: 'a'.repeat(40),
      context: 'overcenter/proof',
      expected_state: 'success',
    },
  });
  const releaseReady = kernel.deriveReadyWork();
  assert.ok(releaseReady);
  const releaseRun = kernel.claim(releaseReady.id, releaseReady.revision);
  await assert.rejects(
    performGitHubCommitStatusEffect(kernel, releaseRun, {
      token: 'token',
      get: () => ({
        id: 42,
        node_id: 'R_42',
        full_name: 'acme/widget',
        name: 'widget',
        owner: { login: 'acme' },
      }),
      post: createGitHubStatusPost({
        lookup: (_host, _options, callback) => callback(null, '127.0.0.2', 4),
      }),
    }),
    /GITHUB_STATUS_MUTATION_NOT_DISPATCHED/,
  );
  assert.equal(kernel.hasUnresolvedEffect(releaseRun.id), false);
  assert.equal(kernel.inspect().find((item) => item.id === 'release')?.status, 'READY');
  const retry = kernel.deriveReadyWork();
  assert.ok(retry);
  kernel.claim(retry.id, retry.revision);
  return { before, after: snapshot(kernel, store) };
}

test('Git and SQLite kernels derive the same logical project transitions', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-30T00:00:00Z') });
  const root = mkdtempSync(join(tmpdir(), 'kernel-backend-differential-'));
  const repoPath = join(root, 'authority.git');
  const database = join(root, 'authority.sqlite');
  const firstPath = join(root, 'first.txt');
  const secondPath = join(root, 'second.txt');
  execFileSync('git', ['init', '--bare', repoPath], { stdio: 'ignore' });

  const sqliteStore = new SqliteFactStore(database);
  const gitStore = new ProductionFactStore(repoPath, { ref: 'refs/overcenter/state' });
  function recording(store: DurableFactStore) {
    const prefixes: unknown[] = [];
    const kernel = new KernelCore({
      head: () => store.head(),
      history: (head) => store.history(head),
      append: (expected, message, files) => {
        const committed = store.append(expected, message, files);
        if (committed) prefixes.push(snapshot(kernel, store));
        return committed;
      },
    });
    return { kernel, prefixes };
  }
  const git = recording(gitStore);
  const sqlite = recording(sqliteStore);

  try {
    const gitResult = await exercise(git.kernel, gitStore, firstPath, secondPath);

    unlinkSync(firstPath);
    unlinkSync(secondPath);

    const sqliteResult = await exercise(sqlite.kernel, sqliteStore, firstPath, secondPath);

    assert.equal(sqlite.prefixes.length, git.prefixes.length);
    for (const [index, prefix] of git.prefixes.entries())
      assert.deepEqual(sqlite.prefixes[index], prefix, `prefix ${index}`);
    assert.deepEqual(sqliteResult.before, gitResult.before);
    assert.deepEqual(sqliteResult.after, gitResult.after);
  } finally {
    sqliteStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
