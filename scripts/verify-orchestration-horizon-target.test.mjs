import test from 'node:test';
import assert from 'node:assert/strict';

import { createOrchestrationRunService } from '../lib/orchestration-runs.js';

// Red contract v3: the CI loader is fixed; this branch changes no production behavior.
const TARGET_A = Object.freeze({
  project_ref: 'portfolio:primary',
  horizon: Object.freeze({ kind: 'project', ref: 'portfolio:primary' }),
});
const TARGET_B = Object.freeze({
  project_ref: 'portfolio:primary',
  horizon: Object.freeze({ kind: 'milestone', ref: 'later' }),
});

function runStore() {
  const rows = new Map();
  const sameTarget = (left, right) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  return {
    rows,
    store: {
      async getRun(id) { return rows.get(id) || null; },
      async findPredecessor(key, scopeSha, target, exclude) {
        return [...rows.values()]
          .filter((row) => row.continuation_key === key && row.scope_sha256 === scopeSha && row.run_id !== exclude && sameTarget(row.target, target))
          .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))[0] || null;
      },
      async insertRun(row) { rows.set(row.run_id, { ...row }); return rows.get(row.run_id); },
      async latestHorizon() { return null; },
    },
  };
}

function responsibilities(done) {
  return Object.fromEntries(['ENABLE', 'ACQUIRE', 'EXECUTE', 'COMMIT', 'CONFIRM'].map((stage) => [stage, { applicable: true, satisfied: done }]));
}

function graph(revision, done = false) {
  return {
    schema: 'project-graph-authority-v1',
    project_ref: 'portfolio:primary',
    authority: {
      definition: {
        kind: 'github',
        repository: 'laurajoyhutchins/overcenter',
        revision,
        derivation: 'overcenter-test-v1',
      },
      observations: [],
    },
    nodes: [{
      id: 'build',
      priority: 1,
      requires: [],
      lifecycle: { current_stage: done ? 'CONFIRM' : 'ENABLE', responsibilities: responsibilities(done) },
      executor: { kind: 'operator', command: 'test.noop' },
    }],
    horizons: [{ kind: 'milestone', ref: 'later', target_node_ids: ['build'] }],
  };
}

function startInput(runId, target = TARGET_A) {
  return {
    run_id: runId,
    worker: 'Fast Forward',
    mode: 'interactive',
    continuation_key: 'targeted:portfolio',
    scope: { project: 'Overcenter', repositories: ['laurajoyhutchins/overcenter'] },
    target,
  };
}

test('run start stores immutable horizon target and target changes conflict on replay', async () => {
  const harness = runStore();
  const service = createOrchestrationRunService({ store: harness.store, now: () => '2026-08-26T20:00:00.000Z' });
  const started = await service.start(startInput('run-target'));
  assert.deepEqual(started.target, TARGET_A);
  assert.deepEqual(harness.rows.get('run-target').target, TARGET_A);
  const replay = await service.start(startInput('run-target'));
  assert.equal(replay.idempotent_replay, true);
  assert.deepEqual(replay.target, TARGET_A);
  await assert.rejects(() => service.start(startInput('run-target', TARGET_B)), (error) => error?.code === 'IDEMPOTENCY_CONFLICT');
});

test('predecessor recovery is isolated by exact horizon target identity', async () => {
  const harness = runStore();
  const service = createOrchestrationRunService({ store: harness.store, now: () => '2026-08-26T20:00:00.000Z' });
  await service.start(startInput('run-a', TARGET_A));
  harness.rows.get('run-a').status = 'finished';
  const different = await service.start(startInput('run-b', TARGET_B));
  assert.equal(different.predecessor_run_id, null);
  const same = await service.start(startInput('run-c', TARGET_A));
  assert.equal(same.predecessor_run_id, 'run-a');
});

test('targeted horizon resolution rereads graph authority and grants no ownership', async () => {
  const harness = runStore();
  let current = graph('a'.repeat(40), false);
  let reads = 0;
  const service = createOrchestrationRunService({
    store: harness.store,
    projectGraphReader: async ({ project_ref }) => {
      assert.equal(project_ref, TARGET_A.project_ref);
      reads += 1;
      return current;
    },
    now: () => '2026-08-26T20:00:00.000Z',
  });
  await service.start(startInput('run-resolve', TARGET_A));
  const incomplete = await service.resolveHorizon({ run_id: 'run-resolve' });
  assert.equal(incomplete.schema, 'project-horizon-evaluation-v1');
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.frontier[0]?.id, 'build');
  assert.equal(incomplete.horizon.authority.revision, 'a'.repeat(40));
  assert.equal(incomplete.ownership_granted, false);

  current = graph('b'.repeat(40), true);
  const complete = await service.resolveHorizon({ run_id: 'run-resolve' });
  assert.equal(complete.complete, true);
  assert.equal(complete.horizon.authority.revision, 'b'.repeat(40));
  assert.equal(reads, 2);
});

test('run target rejects caller-supplied membership and authority coordinates', async () => {
  const harness = runStore();
  const service = createOrchestrationRunService({ store: harness.store, now: () => '2026-08-26T20:00:00.000Z' });
  await assert.rejects(() => service.start(startInput('run-invalid', {
    ...TARGET_A,
    target_node_ids: ['build'],
  })), (error) => error?.code === 'REQUEST_INVALID');
  await assert.rejects(() => service.start(startInput('run-invalid-authority', {
    ...TARGET_A,
    authority: { revision: 'a'.repeat(40) },
  })), (error) => error?.code === 'REQUEST_INVALID');
});