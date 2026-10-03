import assert from 'node:assert/strict';
import test from 'node:test';

import { EffectAdmissionSnapshot } from '../src/authority/effect-admission-snapshot.ts';
import type { HistoricalRun } from '../src/authority/facts.ts';
import type { Projection } from '../src/authority/replay.ts';
import type { ExecutionPermit } from '../src/model.ts';

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

const permit: ExecutionPermit = { ...run, execution_capability: 'secret' };

function projection({ executing = true, unresolved = false } = {}): Projection {
  return {
    state: { obligations: {}, definition_ids: {} },
    definitions: {},
    project: {
      lifecycles: new Map([
        [
          run.obligation_id,
          executing ? { status: 'EXECUTING', run } : { status: 'WAITING', run },
        ],
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

test('exact-head admission snapshot partially evaluates the production rule', () => {
  const snapshot = new EffectAdmissionSnapshot('head', projection());
  assert.equal(snapshot.head, 'head');
  assert.equal(snapshot.runCount, 1);
  assert.deepEqual(snapshot.decide(permit, 'capability'), { admitted: true, run });
});

test('snapshot preserves fail-closed denial precedence', () => {
  assert.deepEqual(
    new EffectAdmissionSnapshot('head', projection()).decide(
      { ...permit, claim_commit: 'stale' },
      'capability',
    ),
    { admitted: false, error: 'STALE_EXECUTION_GENERATION' },
  );
  assert.deepEqual(
    new EffectAdmissionSnapshot('head', projection({ executing: false })).decide(
      permit,
      'capability',
    ),
    { admitted: false, error: 'RUN_NOT_EXECUTING' },
  );
  assert.deepEqual(
    new EffectAdmissionSnapshot('head', projection({ unresolved: true })).decide(
      permit,
      'capability',
    ),
    { admitted: false, error: 'UNRESOLVED_EFFECT' },
  );
  assert.deepEqual(
    new EffectAdmissionSnapshot('head', projection()).decide(
      { ...permit, id: 'unknown' },
      'capability',
    ),
    { admitted: false, error: 'UNKNOWN_RUN' },
  );
});
