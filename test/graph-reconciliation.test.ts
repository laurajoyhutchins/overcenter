import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeObligation } from '../src/authority/facts.ts';
import { planGraphReconciliation } from '../src/graph/reconciliation.ts';

const pc = (path: string, content: string) => ({
  verifier: 'file-content-equals/v1' as const,
  path,
  content,
});

test('graph reconciliation deterministically classifies add rebind and unchanged', () => {
  const unchanged = normalizeObligation({
    id: 'unchanged',
    dependencies: [
      { kind: 'control', upstream: 'root' },
      { kind: 'control', upstream: 'other' },
    ],
    packet: { value: 1 },
    postcondition: pc('/tmp/unchanged', 'A'),
  });
  const changed = normalizeObligation({
    id: 'changed',
    packet: { value: 1 },
    postcondition: pc('/tmp/changed', 'A'),
  });
  const current = [unchanged, changed];

  const plan = planGraphReconciliation(current, [
    {
      id: 'new',
      postcondition: pc('/tmp/new', 'N'),
    },
    {
      id: 'changed',
      packet: { value: 2 },
      postcondition: pc('/tmp/changed', 'A'),
    },
    {
      id: 'unchanged',
      dependencies: [
        { kind: 'control', upstream: 'other' },
        { kind: 'control', upstream: 'root' },
      ],
      packet: { value: 1 },
      postcondition: pc('/tmp/unchanged', 'A'),
    },
  ]);

  assert.deepEqual(
    plan.upsert.map(({ id }) => id),
    ['changed', 'new'],
  );
  assert.deepEqual(plan.added, ['new']);
  assert.deepEqual(plan.rebound, ['changed']);
  assert.deepEqual(plan.unchanged, ['unchanged']);
});

test('graph reconciliation rejects duplicate desired identities', () => {
  assert.throws(
    () =>
      planGraphReconciliation([], [
        { id: 'a', postcondition: pc('/tmp/a', 'A') },
        { id: 'a', postcondition: pc('/tmp/a', 'A') },
      ]),
    /DUPLICATE_DESIRED_OBLIGATION:a/,
  );
});

test('managed reconciliation retires only missing obligations in its namespace', () => {
  const managed = normalizeObligation({
    id: 'tcb:stale',
    postcondition: {
      verifier: 'operator-judgment/v1',
      subject: { kind: 'tcb-remediation' },
    },
  });
  const ordinary = normalizeObligation({
    id: 'ordinary',
    postcondition: pc('/tmp/ordinary', 'A'),
  });
  const plan = planGraphReconciliation(
    [managed, ordinary],
    [{ id: 'ordinary', postcondition: pc('/tmp/ordinary', 'A') }],
    ['tcb:'],
  );

  assert.deepEqual(plan.retire, ['tcb:stale']);
  assert.deepEqual(plan.unchanged, ['ordinary']);
  assert.deepEqual(plan.upsert, []);
});
