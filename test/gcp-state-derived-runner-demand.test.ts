import assert from 'node:assert/strict';
import test from 'node:test';

import type { Work, WorkStatus } from '../src/model.ts';
import {
  GCP_RUNNER_DEMAND_POLICY_SCHEMA,
  projectGcpRunnerDemand,
  type GcpRunnerAuthorityReader,
} from '../src/providers/gcp/state-derived-runner-demand.ts';

const head = 'a'.repeat(40);
const secondHead = 'b'.repeat(40);

const policy = {
  schema: GCP_RUNNER_DEMAND_POLICY_SCHEMA,
  pool: 'overcenter-gcp-warm',
  project: 'project-6b810532-a302-48dc-b56',
  zone: 'us-west1-a',
  managed_instance_group: 'overcenter-gce-runners',
  maximum_instances: 1,
  eligible_obligation_ids: ['run-2', 'run-1'],
};

function item(id: string, status: WorkStatus, patch: Partial<Work> = {}): Work {
  return {
    id,
    status,
    revision: head,
    packet: {},
    dependencies: [],
    postcondition: { verifier: 'operator-judgment/v1', subject: {} },
    ...(status === 'EXECUTING'
      ? {
          run_id: `lease-${id}`,
          claimed_revision: head,
          execution_generation: 1,
        }
      : {}),
    ...patch,
  };
}

function reader(
  work: Work[],
  options: { heads?: Array<string | null>; throws?: boolean } = {},
): GcpRunnerAuthorityReader {
  let index = 0;
  return {
    head: () => (options.heads ? (options.heads[index++] ?? null) : head),
    inspect: () => {
      if (options.throws) throw new Error('lost durable state');
      return work;
    },
  };
}

test('idle authoritative work projects zero runner demand without authorizing a resize', () => {
  const result = projectGcpRunnerDemand(
    reader([item('run-1', 'DONE'), item('run-2', 'WAITING')]),
    policy,
  );
  assert.equal(result.state, 'projected');
  if (result.state !== 'projected') return;
  assert.equal(result.authority_head, head);
  assert.equal(result.capacity_needed, 0);
  assert.deepEqual(result.eligible_ready, []);
  assert.deepEqual(result.eligible_executing, []);
  assert.equal(result.effect_authorized, false);
  assert.equal(result.binding.managed_instance_group, 'overcenter-gce-runners');
  assert.match(result.binding.policy_sha256, /^[a-f0-9]{64}$/);
});

test('ready demand and active authorized executions request at most one worker', () => {
  for (const pair of [
    [item('run-1', 'READY'), item('run-2', 'BLOCKED')],
    [item('run-1', 'EXECUTING'), item('run-2', 'WAITING')],
    [item('run-1', 'READY'), item('run-2', 'EXECUTING')],
  ]) {
    const result = projectGcpRunnerDemand(reader(pair), policy);
    assert.equal(result.state, 'projected');
    if (result.state === 'projected') {
      assert.equal(result.capacity_needed, 1);
      assert.equal(result.effect_authorized, false);
    }
  }
});

test('unbound READY work cannot silently increase another GCP pool demand', () => {
  const result = projectGcpRunnerDemand(
    reader([
      item('run-1', 'DONE'),
      item('run-2', 'DONE'),
      item('outside-the-approved-pool', 'READY'),
    ]),
    policy,
  );
  assert.equal(result.state, 'projected');
  if (result.state === 'projected') assert.equal(result.capacity_needed, 0);
});

test('recovery uncertainty always holds rather than scaling down or waking', () => {
  const result = projectGcpRunnerDemand(
    reader([item('run-1', 'RECOVERY_REQUIRED'), item('run-2', 'READY')]),
    policy,
  );
  assert.deepEqual(result, {
    state: 'hold',
    reason: 'RECOVERY_REQUIRED',
    authority_head: head,
    blocked_obligation_ids: ['run-1'],
    effect_authorized: false,
  });
});

test('moving head is rejected even when the work itself appears idle', () => {
  const result = projectGcpRunnerDemand(
    reader([item('run-1', 'DONE'), item('run-2', 'DONE')], {
      heads: [head, secondHead],
    }),
    policy,
  );
  assert.equal(result.state, 'hold');
  if (result.state === 'hold') assert.equal(result.reason, 'AUTHORITY_HEAD_MOVED');
});

test('inaccessible or uninitialized authority cannot produce a capacity decision', () => {
  for (const source of [reader([], { throws: true }), reader([], { heads: [null] })]) {
    const result = projectGcpRunnerDemand(source, policy);
    assert.equal(result.state, 'hold');
    if (result.state === 'hold') assert.equal(result.reason, 'AUTHORITY_UNAVAILABLE');
  }
});

test('missing or duplicated persisted obligations refuse derived capacity', () => {
  const missing = projectGcpRunnerDemand(reader([item('run-1', 'DONE')]), policy);
  assert.equal(missing.state, 'hold');
  if (missing.state === 'hold') {
    assert.equal(missing.reason, 'TRACKED_OBLIGATION_MISSING');
    assert.deepEqual(missing.blocked_obligation_ids, ['run-2']);
  }
  const duplicate = projectGcpRunnerDemand(
    reader([item('run-1', 'DONE'), item('run-1', 'DONE'), item('run-2', 'DONE')]),
    policy,
  );
  assert.equal(duplicate.state, 'hold');
  if (duplicate.state === 'hold') assert.equal(duplicate.reason, 'INVALID_AUTHORITY_STATE');
});

test('an executing obligation must carry a claimed run and generation', () => {
  for (const patch of [
    { run_id: '' },
    { claimed_revision: 'stale-ref' },
    { execution_generation: 0 },
  ]) {
    const result = projectGcpRunnerDemand(
      reader([item('run-1', 'EXECUTING', patch), item('run-2', 'DONE')]),
      policy,
    );
    assert.equal(result.state, 'hold');
    if (result.state === 'hold') assert.equal(result.reason, 'INVALID_EXECUTION_CLAIM');
  }
});

test('policy refuses additional control fields, duplicate or empty work bindings, and capacity expansion', () => {
  for (const unsafe of [
    { ...policy, maximum_instances: 2 },
    { ...policy, command: 'gcloud compute instance-groups managed resize' },
    { ...policy, eligible_obligation_ids: [] },
    { ...policy, eligible_obligation_ids: ['run-1', 'run-1'] },
    { ...policy, zone: 'us-west1-a/../us-east1-b' },
    { ...policy, project: 'foreign/project' },
  ]) {
    const result = projectGcpRunnerDemand(
      reader([item('run-1', 'READY'), item('run-2', 'DONE')]),
      unsafe,
    );
    assert.equal(result.state, 'hold');
    if (result.state === 'hold') assert.equal(result.reason, 'INVALID_POLICY');
  }
});

test('policy digest and results do not depend on allowlist or observation order', () => {
  const a = projectGcpRunnerDemand(
    reader([item('run-1', 'READY'), item('run-2', 'EXECUTING')]),
    policy,
  );
  const b = projectGcpRunnerDemand(reader([item('run-2', 'EXECUTING'), item('run-1', 'READY')]), {
    ...policy,
    eligible_obligation_ids: ['run-1', 'run-2'],
  });
  assert.deepEqual(a, b);
});
