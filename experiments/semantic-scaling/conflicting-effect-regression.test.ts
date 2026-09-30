import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeObligation, type State } from '../../src/authority/facts.ts';
import { interactionFrontier } from '../../src/authority/interaction-frontier.ts';

const COMMIT = 'a'.repeat(40);

function statusObligation(
  id: string,
  context: string,
  expectedState: 'success' | 'failure',
  dependencies: Array<{ kind: 'control'; upstream: string }> = [],
) {
  return normalizeObligation({
    id,
    dependencies,
    postcondition: {
      verifier: 'github-commit-status/v2',
      provider: 'github',
      repository_id: 42,
      repository_full_name: 'acme/widget',
      commit_sha: COMMIT,
      context,
      expected_state: expectedState,
    },
  });
}

function state(...obligations: ReturnType<typeof statusObligation>[]): State {
  return {
    obligations: Object.fromEntries(obligations.map((obligation) => [obligation.id, obligation])),
    definition_ids: Object.fromEntries(
      obligations.map((obligation) => [obligation.id, `definition:${obligation.id}`]),
    ),
  };
}

test('historical conflicting-status counterexample remains one interaction component', () => {
  const frontier = interactionFrontier(
    state(
      statusObligation('alpha', 'Overcenter/Build', 'success'),
      statusObligation('beta', 'overcenter/build', 'failure'),
    ),
  );

  assert.equal(frontier.conflictEdges, 1);
  assert.equal(frontier.causalEdges, 0);
  assert.deepEqual(frontier.components, [['alpha', 'beta']]);
});

test('same desired GitHub status commutes under the same canonical coordinate', () => {
  const frontier = interactionFrontier(
    state(
      statusObligation('alpha', 'Overcenter/Build', 'success'),
      statusObligation('beta', 'overcenter/build', 'success'),
    ),
  );

  assert.equal(frontier.conflictEdges, 0);
  assert.equal(frontier.causalEdges, 0);
  assert.deepEqual(frontier.components, [['alpha'], ['beta']]);
});

test('explicit ordering remains visible independently of conflict classification', () => {
  const frontier = interactionFrontier(
    state(
      statusObligation('alpha', 'overcenter/build', 'success'),
      statusObligation('beta', 'overcenter/build', 'failure', [
        { kind: 'control', upstream: 'alpha' },
      ]),
    ),
  );

  assert.equal(frontier.conflictEdges, 1);
  assert.equal(frontier.causalEdges, 1);
  assert.deepEqual(frontier.components, [['alpha', 'beta']]);
});
