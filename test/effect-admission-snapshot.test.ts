import assert from 'node:assert/strict';
import test from 'node:test';

import { EffectAdmissionSnapshot } from '../src/authority/effect-admission-snapshot.ts';
import type { HistoricalRun } from '../src/authority/facts.ts';
import type { Projection } from '../src/authority/replay.ts';

const run: HistoricalRun = {
  id: 'run',
  obligation_id: 'obligation',
  claimed_revision: 'revision',
  claim_commit: 'claim',
  obligation_key: 'key',
  execution_generation: 7,
  execution_authority_commit: 'authority',
  execution_capability_sha256: 'capability',
  definition_id: 'definition',
  obligation: {
    id: 'obligation',
    dependencies: [],
    packet: {},
    postcondition: { verifier: 'source-integration/v1' },
  },
};

function projection({ executing = true, unresolved = false } = {}): Projection {
  return {
    state: { obligations: {}, definition_ids: {} },
    definitions: {},
    project: {
      lifecycles: new Map([
        [run.obligation_id, executing ? { status: 'EXECUTING', run } : { status: 'WAITING', run }],
      ]),
      semanticKeys: new Map(),
      explanations: new Map(),
      work: [],
      claimabilityErrors: new Map(),
      readyWork: null,
    },
    history: {
      runs: new Map([[run.id, run]]),
      receiptsByRun: new Map(),
      unresolvedReservationsByRun: unresolved
        ? new Map([
            [
              run.id,
              {
                reservation_commit: 'reservation',
                execution_generation: run.execution_generation,
                execution_authority_commit: run.execution_authority_commit,
              },
            ],
          ])
        : new Map(),
      receipts: [],
      currentBindingOrdinals: new Map(),
      claimOrdinalsByRun: new Map(),
      authorityOrdinal: 1,
    },
  };
}

test('exact-head admission snapshot materializes only production input data', () => {
  const snapshot = new EffectAdmissionSnapshot('head', projection());
  assert.equal(snapshot.head, 'head');
  assert.equal(snapshot.runCount, 1);
  assert.equal(snapshot.run(run.id), run);
  assert.equal(snapshot.executing(run.id), true);
  assert.equal(snapshot.unresolvedReservationsByRun.has(run.id), false);
});

test('snapshot materializes lifecycle and unresolved-reservation predicates independently', () => {
  const blocked = new EffectAdmissionSnapshot(
    'head',
    projection({ executing: false, unresolved: true }),
  );
  assert.equal(blocked.run(run.id), run);
  assert.equal(blocked.executing(run.id), false);
  assert.equal(blocked.unresolvedReservationsByRun.has(run.id), true);
  assert.equal(blocked.run('unknown'), undefined);
  assert.equal(blocked.executing('unknown'), false);
  assert.equal(blocked.unresolvedReservationsByRun.has('unknown'), false);
});


test('snapshot exactly preserves all lifecycle and unresolved input combinations', () => {
  for (const executing of [false, true]) {
    for (const unresolved of [false, true]) {
      const source = projection({ executing, unresolved });
      const snapshot = new EffectAdmissionSnapshot('head', source);
      const lifecycle = source.project.lifecycles.get(run.obligation_id);
      const canonicalExecuting =
        lifecycle?.run?.id === run.id && lifecycle.status === 'EXECUTING';
      const canonicalUnresolved = source.history.unresolvedReservationsByRun.has(run.id);

      assert.equal(snapshot.run(run.id), source.history.runs.get(run.id));
      assert.equal(snapshot.executing(run.id), canonicalExecuting);
      assert.equal(snapshot.unresolvedReservationsByRun.has(run.id), canonicalUnresolved);
    }
  }
});
