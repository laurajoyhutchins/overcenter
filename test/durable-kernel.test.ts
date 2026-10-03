import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { GitFactStore } from './fixtures/git-fact-store.ts';
import test from 'node:test';

import { LocalGitKernel, runCoreLoop } from './fixtures/local-git-kernel.ts';
import type { ObligationInput } from '../src/authority/facts.ts';
import { planGraphReconciliation } from '../src/graph/reconciliation.ts';

const pc = (path: string, content: string) => ({
  verifier: 'file-content-equals/v1' as const,
  path,
  content,
});

function history(repo: string) {
  const store = new GitFactStore(repo, { ref: 'refs/overcenter/state' });
  return store.history(store.head()!);
}

function corruptGraphFact(repo: string): void {
  const commit = history(repo)[1]!.commit;
  const blob = execFileSync('git', ['-C', repo, 'rev-parse', `${commit}:graph-patch.json`], {
    encoding: 'utf8',
  }).trim();
  const db = new DatabaseSync(join(repo, 'overcenter.sqlite'));
  db.prepare('UPDATE objects SET bytes = ? WHERE id = ?').run(Buffer.from('{}'), blob);
  db.close();
}

function reconcileGraphTransaction(
  kernel: LocalGitKernel,
  desired: ObligationInput[],
  expectedRevision: string,
) {
  const plan = planGraphReconciliation(kernel.inspect(), desired);
  if (plan.upsert.length === 0) {
    if (kernel.head() !== expectedRevision) throw new Error('STALE_REVISION');
    return {
      revision: expectedRevision,
      added: plan.added,
      rebound: plan.rebound,
      retired: [],
      unchanged: plan.unchanged,
    };
  }
  const revision = kernel.applyGraphPatch({ upsert: plan.upsert }, expectedRevision);
  return {
    revision,
    added: plan.added,
    rebound: plan.rebound,
    retired: [],
    unchanged: plan.unchanged,
  };
}

test('Git production kernel reconstructs project truth after close and reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-kernel-'));
  const database = join(root, 'overcenter.git');
  const firstPath = join(root, 'first.txt');
  const secondPath = join(root, 'second.txt');
  const kernel = new LocalGitKernel(database);

  try {
    const initial = kernel.initialize();
    assert.equal(kernel.head(), initial);

    kernel.define({
      id: 'first',
      packet: { path: firstPath, content: 'A' },
      postcondition: pc(firstPath, 'A'),
    });
    kernel.define({
      id: 'second',
      dependencies: [{ kind: 'control', upstream: 'first' }],
      packet: { path: secondPath, content: 'B' },
      postcondition: pc(secondPath, 'B'),
    });

    const result = await runCoreLoop(kernel, {
      effect: async (packet) => {
        writeFileSync(String(packet.path), String(packet.content));
        return { kind: 'ok' };
      },
    });
    assert.equal(result.state, 'IDLE');

    const before = kernel.inspect();
    assert.deepEqual(
      before.map((work) => [work.id, work.status]),
      [
        ['first', 'DONE'],
        ['second', 'DONE'],
      ],
    );
    const beforeExplanations = before.map((work) => kernel.explain(work.id));
    const beforeReceipts = kernel.receipts();
    const head = kernel.head();
    assert.ok(head);

    kernel.close();

    const fresh = new LocalGitKernel(database);
    try {
      assert.equal(fresh.initialize(), head);
      assert.deepEqual(fresh.inspect(), before);
      assert.deepEqual(
        fresh.inspect().map((work) => fresh.explain(work.id)),
        beforeExplanations,
      );
      assert.deepEqual(fresh.receipts(), beforeReceipts);
    } finally {
      fresh.close();
    }

    for (const fact of history(database).filter((fact) => fact.receipt !== null)) {
      const receipt = fact.receipt as Record<string, unknown>;
      assert.equal('disposition' in receipt, false);
      assert.equal('verified' in receipt, false);
    }
  } finally {
    try {
      kernel.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git graph patch admits multiple nodes in one authority transition', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-graph-patch-'));
  const database = join(root, 'overcenter.git');
  const kernel = new LocalGitKernel(database);
  try {
    const initial = kernel.initialize();
    const commit = kernel.applyGraphPatch(
      {
        upsert: [
          {
            id: 'second',
            dependencies: [{ kind: 'control', upstream: 'first' }],
            postcondition: pc(join(root, 'second'), 'B'),
          },
          {
            id: 'first',
            postcondition: pc(join(root, 'first'), 'A'),
          },
        ],
      },
      initial,
    );

    assert.equal(kernel.head(), commit);
    assert.deepEqual(
      kernel.inspect().map((work) => [work.id, work.status]),
      [
        ['first', 'READY'],
        ['second', 'BLOCKED'],
      ],
    );

    const facts = history(database);
    assert.equal(facts.length, 2);
    const patch = facts[1]?.graph_patch as {
      definitions: unknown[];
      bindings: unknown[];
      retire: unknown[];
    };
    assert.equal(patch.definitions.length, 2);
    assert.equal(patch.bindings.length, 2);
    assert.deepEqual(patch.retire, []);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git graph reconciliation derives add rebind and no-op without extra writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-graph-reconcile-'));
  const database = join(root, 'overcenter.git');
  const kernel = new LocalGitKernel(database);
  try {
    const initial = kernel.initialize();
    const first = reconcileGraphTransaction(
      kernel,
      [
        { id: 'root', postcondition: pc(join(root, 'root'), 'R') },
        {
          id: 'leaf',
          dependencies: [{ kind: 'control', upstream: 'root' }],
          packet: { generation: 1 },
          postcondition: pc(join(root, 'leaf'), 'L'),
        },
      ],
      initial,
    );
    assert.deepEqual(first.added, ['leaf', 'root']);
    assert.deepEqual(first.rebound, []);
    assert.deepEqual(first.unchanged, []);

    const unchanged = reconcileGraphTransaction(
      kernel,
      [
        {
          id: 'leaf',
          dependencies: [{ kind: 'control', upstream: 'root' }],
          packet: { generation: 1 },
          postcondition: pc(join(root, 'leaf'), 'L'),
        },
        { id: 'root', postcondition: pc(join(root, 'root'), 'R') },
      ],
      first.revision,
    );
    assert.equal(unchanged.revision, first.revision);
    assert.deepEqual(unchanged.added, []);
    assert.deepEqual(unchanged.rebound, []);
    assert.deepEqual(unchanged.unchanged, ['leaf', 'root']);

    const changed = reconcileGraphTransaction(
      kernel,
      [
        {
          id: 'leaf',
          dependencies: [{ kind: 'control', upstream: 'root' }],
          packet: { generation: 2 },
          postcondition: pc(join(root, 'leaf'), 'L'),
        },
        { id: 'extra', postcondition: pc(join(root, 'extra'), 'E') },
      ],
      unchanged.revision,
    );
    assert.deepEqual(changed.added, ['extra']);
    assert.deepEqual(changed.rebound, ['leaf']);
    assert.deepEqual(changed.unchanged, []);

    assert.equal(history(database).length, 3);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('no-op graph reconciliation remains read-only while work is in flight', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-graph-reconcile-busy-noop-'));
  const database = join(root, 'overcenter.git');
  const kernel = new LocalGitKernel(database);
  try {
    const initial = kernel.initialize();
    const defined = reconcileGraphTransaction(
      kernel,
      [{ id: 'a', packet: { value: 1 }, postcondition: pc(join(root, 'a'), 'A') }],
      initial,
    );
    const run = kernel.claim('a', defined.revision);
    const head = kernel.head();
    assert.ok(head);

    const result = reconcileGraphTransaction(
      kernel,
      [{ id: 'a', packet: { value: 1 }, postcondition: pc(join(root, 'a'), 'A') }],
      head,
    );
    assert.equal(result.revision, head);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.rebound, []);
    assert.deepEqual(result.unchanged, ['a']);

    assert.throws(
      () =>
        reconcileGraphTransaction(
          kernel,
          [{ id: 'a', packet: { value: 2 }, postcondition: pc(join(root, 'a'), 'A') }],
          head,
        ),
      /PROJECT_BUSY/,
    );
    assert.equal(kernel.head(), head);
    kernel.recoverInterrupted(run);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid Git graph patch leaves authority unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-invalid-graph-patch-'));
  const database = join(root, 'overcenter.git');
  const kernel = new LocalGitKernel(database);
  try {
    const initial = kernel.initialize();
    assert.throws(
      () =>
        kernel.applyGraphPatch(
          {
            upsert: [
              {
                id: 'dangling',
                dependencies: [{ kind: 'control', upstream: 'missing' }],
                postcondition: pc(join(root, 'dangling'), 'A'),
              },
            ],
          },
          initial,
        ),
      /UNKNOWN_DEPENDENCY:dangling:missing/,
    );
    assert.equal(kernel.head(), initial);

    assert.equal(history(database).length, 1);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('graph patch rebinding is exact-revision fenced', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-graph-patch-replace-'));
  const kernel = new LocalGitKernel(join(root, 'overcenter.git'));
  try {
    const initial = kernel.initialize();
    const defined = kernel.applyGraphPatch(
      {
        upsert: [{ id: 'a', postcondition: pc(join(root, 'a'), 'A') }],
      },
      initial,
    );
    const rebound = kernel.applyGraphPatch(
      {
        upsert: [{ id: 'a', packet: { generation: 2 }, postcondition: pc(join(root, 'a'), 'B') }],
      },
      defined,
    );
    assert.equal(kernel.head(), rebound);
    assert.throws(
      () =>
        kernel.applyGraphPatch(
          {
            upsert: [{ id: 'a', postcondition: pc(join(root, 'a'), 'C') }],
          },
          defined,
        ),
      /STALE_REVISION/,
    );
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('retirement validates the complete resulting graph atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-graph-retire-'));
  const kernel = new LocalGitKernel(join(root, 'overcenter.git'));
  try {
    const initial = kernel.initialize();
    const built = kernel.applyGraphPatch(
      {
        upsert: [
          { id: 'first', postcondition: pc(join(root, 'first'), 'A') },
          {
            id: 'second',
            dependencies: [{ kind: 'control', upstream: 'first' }],
            postcondition: pc(join(root, 'second'), 'B'),
          },
        ],
      },
      initial,
    );

    assert.throws(
      () => kernel.applyGraphPatch({ retire: ['first'] }, built),
      /UNKNOWN_DEPENDENCY:second:first/,
    );
    assert.equal(kernel.head(), built);

    const retired = kernel.applyGraphPatch(
      {
        upsert: [
          {
            id: 'second',
            postcondition: pc(join(root, 'second'), 'B'),
          },
        ],
        retire: ['first'],
      },
      built,
    );
    assert.equal(kernel.head(), retired);
    assert.deepEqual(
      kernel.inspect().map((work) => [work.id, work.status]),
      [['second', 'READY']],
    );
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('retired node can rebind the same immutable definition and reuse evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-graph-reintroduce-'));
  const database = join(root, 'overcenter.git');
  const path = join(root, 'a');
  const kernel = new LocalGitKernel(database);
  try {
    kernel.initialize();
    kernel.define({
      id: 'a',
      packet: { kind: 'same-definition' },
      postcondition: pc(path, 'A'),
    });
    const run = kernel.claim('a', kernel.deriveReadyWork()!.revision);
    writeFileSync(path, 'A');
    assert.equal(kernel.resolve(run).disposition, 'DONE');

    kernel.applyGraphPatch({ retire: ['a'] }, kernel.head()!);
    assert.deepEqual(kernel.inspect(), []);

    kernel.applyGraphPatch(
      {
        upsert: [
          {
            id: 'a',
            packet: { kind: 'same-definition' },
            postcondition: pc(path, 'A'),
          },
        ],
      },
      kernel.head()!,
    );
    assert.equal(kernel.inspect()[0]?.status, 'DONE');
    assert.equal(kernel.inspect()[0]?.run_id, run.id);

    const patches = history(database).filter((fact) => fact.graph_patch !== null);
    assert.equal(patches.length, 3);
    const reintroduced = patches[2]?.graph_patch as {
      definitions: unknown[];
      bindings: unknown[];
      retire: unknown[];
    };
    assert.deepEqual(reintroduced.definitions, []);
    assert.equal(reintroduced.bindings.length, 1);
    assert.deepEqual(reintroduced.retire, []);
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git kernel rejects every inexact execution permit identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-execution-authority-'));
  const kernel = new LocalGitKernel(join(root, 'overcenter.git'));
  try {
    kernel.initialize();
    kernel.define({ id: 'a', postcondition: pc(join(root, 'a'), 'A') });
    const run = kernel.claim('a', kernel.deriveReadyWork()!.revision);
    for (const hostile of [
      { ...run, obligation_id: 'other' },
      { ...run, claimed_revision: 'stale' },
      { ...run, claim_commit: 'stale' },
      { ...run, obligation_key: 'stale' },
      { ...run, execution_generation: run.execution_generation + 1 },
      { ...run, execution_authority_commit: 'stale' },
      { ...run, execution_capability_sha256: '0'.repeat(64) },
      { ...run, execution_capability: 'wrong' },
    ]) {
      assert.throws(() => kernel.beginEffect(hostile), /STALE_EXECUTION_GENERATION/);
      assert.throws(() => kernel.resolve(hostile), /STALE_EXECUTION_GENERATION/);
    }
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git kernel rejects a claim fenced to a stale authority revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-stale-revision-'));
  const database = join(root, 'overcenter.git');
  const first = new LocalGitKernel(database);
  const second = new LocalGitKernel(database);

  try {
    first.initialize();
    first.define({
      id: 'a',
      postcondition: pc(join(root, 'a'), 'A'),
    });
    const stale = first.deriveReadyWork();
    assert.ok(stale);

    second.define({
      id: 'b',
      postcondition: pc(join(root, 'b'), 'B'),
    });

    assert.throws(() => first.claim('a', stale.revision), /STALE_REVISION/);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git replay fails closed when durable fact bytes no longer match their commit id', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-corruption-'));
  const database = join(root, 'overcenter.git');
  const kernel = new LocalGitKernel(database);

  try {
    kernel.initialize();
    kernel.define({
      id: 'a',
      postcondition: pc(join(root, 'a'), 'A'),
    });
    kernel.close();

    corruptGraphFact(database);

    const corrupted = new LocalGitKernel(database);
    try {
      assert.throws(() => corrupted.inspect(), /FACT_OBJECT_DIGEST_MISMATCH/);
    } finally {
      corrupted.close();
    }
  } finally {
    try {
      kernel.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('judgment receipt requires a fresh execution generation before effect resume', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-judgment-resume-'));
  const kernel = new LocalGitKernel(join(root, 'overcenter.git'));
  try {
    kernel.initialize();
    const path = join(root, 'authorized');
    kernel.define({
      id: 'authorization',
      postcondition: pc(path, 'done'),
    });
    const first = kernel.claim('authorization', kernel.deriveReadyWork()!.revision);
    const waiting = kernel.deferForJudgment(first, {
      reason: 'authorization-required',
    });
    assert.equal(waiting.disposition, 'WAITING');

    assert.throws(
      () => kernel.beginEffect(first),
      /RUN_NOT_EXECUTING/,
      'the pre-judgment capability must not cross the effect boundary',
    );

    const resumed = kernel.acquireExecution(first.id);
    assert.equal(resumed.execution_generation, first.execution_generation + 1);
    assert.doesNotThrow(() => kernel.beginEffect(resumed));
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git projection cache recovers after historical claimed-work lookup', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-projection-cache-history-'));
  const database = join(root, 'overcenter.git');
  const kernel = new LocalGitKernel(database);

  try {
    kernel.initialize();
    kernel.define({ id: 'a', postcondition: pc(join(root, 'a'), 'A') });
    const ready = kernel.deriveReadyWork();
    assert.ok(ready);
    const run = kernel.claim('a', ready.revision);
    writeFileSync(join(root, 'a'), 'A');
    assert.equal(kernel.resolve(run).disposition, 'DONE');

    const currentHead = kernel.head();
    assert.ok(currentHead);
    assert.equal(kernel.inspect()[0]?.status, 'DONE');

    const claimed = kernel.claimedWork(run.id);
    assert.equal(claimed.status, 'EXECUTING');
    assert.equal(claimed.revision, run.claim_commit);

    assert.equal(kernel.head(), currentHead);
    assert.equal(kernel.inspect()[0]?.status, 'DONE');
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Git projection cache follows external heads and never bypasses durable validation', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-projection-cache-'));
  const database = join(root, 'overcenter.git');
  const first = new LocalGitKernel(database);
  const second = new LocalGitKernel(database);

  try {
    first.initialize();
    first.define({ id: 'a', postcondition: pc(join(root, 'a'), 'A') });
    assert.deepEqual(
      first.inspect().map((work) => work.id),
      ['a'],
    );

    second.define({ id: 'b', postcondition: pc(join(root, 'b'), 'B') });
    assert.deepEqual(
      first.inspect().map((work) => work.id),
      ['a', 'b'],
    );

    corruptGraphFact(database);

    assert.throws(() => first.inspect(), /FACT_OBJECT_DIGEST_MISMATCH/);
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('core loop overlaps bounded effects without widening authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-core-loop-concurrency-'));
  const kernel = new LocalGitKernel(join(root, 'overcenter.git'));
  let active = 0;
  let maxActive = 0;

  try {
    kernel.initialize();
    for (const id of ['a', 'b', 'c', 'd']) {
      const path = join(root, id);
      kernel.define({
        id,
        packet: { id, path, content: id.toUpperCase() },
        postcondition: pc(path, id.toUpperCase()),
      });
    }

    const result = await runCoreLoop(kernel, {
      concurrency: 4,
      effect: async (packet) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        writeFileSync(String(packet.path), String(packet.content));
        active -= 1;
        return { kind: 'ok' };
      },
    });

    assert.equal(result.state, 'IDLE');
    assert.equal(maxActive, 4);
    assert.ok(kernel.inspect().every((work) => work.status === 'DONE'));
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded core-loop capacity selects independent READY peers within a wave', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-core-loop-wave-'));
  const kernel = new LocalGitKernel(join(root, 'overcenter.git'));
  const seen: string[] = [];

  try {
    kernel.initialize();
    for (const id of ['a', 'b']) {
      const path = join(root, id);
      kernel.define({
        id,
        packet: { id, path, content: id.toUpperCase() },
        postcondition: pc(path, id.toUpperCase()),
      });
    }

    const result = await runCoreLoop(kernel, {
      concurrency: 2,
      maxAdvances: 2,
      effect: async (packet) => {
        const id = String(packet.id);
        seen.push(id);
        writeFileSync(String(packet.path), String(packet.content));
        return { kind: 'ok' };
      },
    });

    assert.equal(result.state, 'BUDGET_EXHAUSTED');
    assert.deepEqual(seen, ['a', 'b']);
    assert.deepEqual(
      kernel.inspect().map((work) => [work.id, work.status]),
      [
        ['a', 'DONE'],
        ['b', 'DONE'],
      ],
    );
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent core loop drains started effects before returning WAITING', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-core-loop-waiting-'));
  const kernel = new LocalGitKernel(join(root, 'overcenter.git'));
  let firstEffectStarted = false;

  try {
    kernel.initialize();
    for (const id of ['a', 'b']) {
      const path = join(root, id);
      kernel.define({
        id,
        packet: { id, path, content: id.toUpperCase() },
        postcondition: pc(path, id.toUpperCase()),
      });
    }

    const result = await runCoreLoop(kernel, {
      concurrency: 2,
      preflight: async (packet) => {
        if (packet.id === 'b') {
          assert.equal(firstEffectStarted, true);
          return { kind: 'judgment-required', question: 'human choice required' };
        }
        return { kind: 'execute' };
      },
      effect: async (packet) => {
        firstEffectStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        writeFileSync(String(packet.path), String(packet.content));
        return { kind: 'ok' };
      },
    });

    assert.equal(result.state, 'WAITING');
    assert.equal(result.work, 'b');
    assert.deepEqual(
      kernel.inspect().map((work) => [work.id, work.status]),
      [
        ['a', 'DONE'],
        ['b', 'WAITING'],
      ],
    );
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('core loop rejects invalid concurrency before mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'git-core-loop-invalid-concurrency-'));
  const kernel = new LocalGitKernel(join(root, 'overcenter.git'));

  try {
    kernel.initialize();
    kernel.define({ id: 'a', packet: {}, postcondition: pc(join(root, 'a'), 'A') });
    const before = kernel.head();

    await assert.rejects(
      runCoreLoop(kernel, {
        concurrency: 0,
        effect: async () => ({ kind: 'ok' }),
      }),
      /INVALID_CONCURRENCY/,
    );

    assert.equal(kernel.head(), before);
    assert.equal(kernel.inspect()[0]?.status, 'READY');
  } finally {
    kernel.close();
    rmSync(root, { recursive: true, force: true });
  }
});
