import assert from 'node:assert/strict';
import test from 'node:test';

import type { Work, WorkStatus } from '../src/model.ts';
import {
  GCP_RUNNER_DEMAND_POLICY_SCHEMA,
  type GcpRunnerAuthorityReader,
} from '../src/providers/gcp/state-derived-runner-demand.ts';
import { planGcpRunnerLeases } from '../src/providers/gcp/state-derived-runner-leases.ts';
import type { GcpRunnerJobObservation } from '../src/providers/gcp/state-derived-runner-leases.ts';
import type { RunnerAutoscalerConfig } from '../src/transport/gcp-runner-autoscaler.ts';

const revision = 'a'.repeat(40);
const repository = {
  full_name: 'laurajoyhutchins/arcata',
  repository_id: 1_402_666_660,
  owner_id: 219_002_713,
};
const config: RunnerAutoscalerConfig = {
  schema: 'overcenter-gcp-runner-autoscaler/v1',
  poll_interval_ms: 2_000,
  redispatch_after_ms: 600_000,
  runner_label: 'overcenter-gcp',
  repositories: [repository],
};
const policy = {
  schema: GCP_RUNNER_DEMAND_POLICY_SCHEMA,
  pool: 'overcenter-gcp-warm',
  project: 'project-6b810532-a302-48dc-b56',
  zone: 'us-west1-a',
  managed_instance_group: 'overcenter-gce-runners',
  maximum_instances: 1,
  eligible_obligation_ids: ['eligible'],
};
const launch = {
  repository: repository.full_name,
  repository_id: repository.repository_id,
  owner_id: repository.owner_id,
  job_id: 123_456,
  runner_label: 'overcenter-gcp-warm-12345-verification-1',
};

function work(
  status: WorkStatus,
  packet: Record<string, unknown> = { gcp_runner_job: launch },
  id = 'eligible',
): Work {
  return {
    id,
    status,
    revision,
    packet,
    dependencies: [],
    postcondition: { verifier: 'operator-judgment/v1', subject: {} },
    ...(status === 'EXECUTING'
      ? {
          run_id: 'run-exact',
          claimed_revision: revision,
          execution_generation: 1,
        }
      : {}),
  };
}

function authority(items: Work[], heads: readonly string[] = [revision]): GcpRunnerAuthorityReader {
  let reads = 0;
  return {
    head: () => heads[Math.min(reads++, heads.length - 1)] ?? null,
    inspect: () => items,
  };
}

function observed(status = 'queued', runnerLabel = launch.runner_label): GcpRunnerJobObservation[] {
  return [
    {
      repository,
      complete: true,
      jobs: [{ id: launch.job_id, status, labels: ['self-hosted', runnerLabel] }],
    },
  ];
}

test('an exact claimed execution and queued GitHub job yields a bound proposal, not authority', () => {
  const result = planGcpRunnerLeases(authority([work('EXECUTING')]), policy, config, observed());
  assert.equal(result.state, 'ready');
  if (result.state !== 'ready') return;
  assert.equal(result.effect_authorized, false);
  assert.equal(result.capacity_needed, 1);
  assert.equal(result.authority_head, revision);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0]?.launch, launch);
  assert.equal(result.candidates[0]?.obligation_id, 'eligible');
  assert.equal(result.candidates[0]?.run_id, 'run-exact');
  assert.match(result.candidates[0]?.policy_sha256 ?? '', /^[a-f0-9]{64}$/);
});

test('ready work creates demand but cannot publish a lease without a claim', () => {
  const result = planGcpRunnerLeases(authority([work('READY')]), policy, config, observed());
  assert.equal(result.state, 'ready');
  if (result.state === 'ready') {
    assert.equal(result.capacity_needed, 1);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.effect_authorized, false);
  }
});

test('done work has no runner demand even when an unrelated queued job exists', () => {
  const result = planGcpRunnerLeases(authority([work('DONE')]), policy, config, observed());
  assert.equal(result.state, 'ready');
  if (result.state === 'ready') {
    assert.equal(result.capacity_needed, 0);
    assert.deepEqual(result.candidates, []);
  }
});

test('a missing, running or cancelled GitHub job can never authorize publication', () => {
  for (const observedJobs of [
    [{ repository, complete: true as const, jobs: [] }],
    observed('in_progress'),
    observed('completed'),
  ]) {
    const result = planGcpRunnerLeases(
      authority([work('EXECUTING')]),
      policy,
      config,
      observedJobs,
    );
    assert.equal(result.state, 'hold');
    if (result.state === 'hold') {
      assert.equal(result.reason, 'EXECUTION_JOB_NOT_QUEUED');
      assert.equal(result.effect_authorized, false);
    }
  }
});

test('an incomplete, mismatched or duplicate repository snapshot fails closed', () => {
  for (const snapshots of [
    [],
    [{ ...observed()[0]!, repository: { ...repository, owner_id: 1 } }],
    [...observed(), ...observed()],
  ]) {
    const result = planGcpRunnerLeases(authority([work('EXECUTING')]), policy, config, snapshots);
    assert.equal(result.state, 'hold');
    assert.equal(result.effect_authorized, false);
  }
});

test('the runner label must match exactly, not only share an allowed prefix', () => {
  const result = planGcpRunnerLeases(
    authority([work('EXECUTING')]),
    policy,
    config,
    observed('queued', 'overcenter-gcp-different'),
  );
  assert.equal(result.state, 'hold');
  if (result.state === 'hold') {
    assert.equal(result.reason, 'EXECUTION_JOB_LABEL_MISMATCH');
  }
});

test('a Cloud Build label cannot be mistaken for warm GCE pool demand', () => {
  const cloudBuildLabel = 'overcenter-gcp-cloudbuild-123';
  const result = planGcpRunnerLeases(
    authority([
      work('EXECUTING', {
        gcp_runner_job: { ...launch, runner_label: cloudBuildLabel },
      }),
    ]),
    policy,
    config,
    observed('queued', cloudBuildLabel),
  );
  assert.equal(result.state, 'hold');
  if (result.state === 'hold') {
    assert.equal(result.reason, 'EXECUTION_OUTSIDE_WARM_POOL');
  }
});

test('an incorrect pool prefix cannot widen the trusted execution route', () => {
  const result = planGcpRunnerLeases(
    authority([work('EXECUTING')]),
    { ...policy, pool: 'cloudbuild' },
    config,
    observed(),
  );
  assert.equal(result.state, 'hold');
  if (result.state === 'hold') {
    assert.equal(result.reason, 'WARM_POOL_ROUTE_MISMATCH');
  }
});

test('unbound or smuggled job identities and foreign projects remain rejected', () => {
  for (const packet of [
    {},
    { gcp_runner_job: { ...launch, job_id: 555 } },
    { gcp_runner_job: { ...launch, foreign: true } },
    { gcp_runner_job: { ...launch, owner_id: 99 } },
  ]) {
    const result = planGcpRunnerLeases(
      authority([work('EXECUTING', packet)]),
      policy,
      config,
      observed(),
    );
    assert.equal(result.state, 'hold');
  }
  const result = planGcpRunnerLeases(
    authority([work('EXECUTING')]),
    { ...policy, maximum_instances: 2 },
    config,
    observed(),
  );
  assert.equal(result.state, 'hold');
});

test('moving authority head, WAITING or RECOVERY_REQUIRED never produces candidates', () => {
  for (const result of [
    planGcpRunnerLeases(
      authority([work('EXECUTING')], [revision, revision, revision, 'b'.repeat(40)]),
      policy,
      config,
      observed(),
    ),
    planGcpRunnerLeases(authority([work('WAITING')]), policy, config, observed()),
    planGcpRunnerLeases(authority([work('RECOVERY_REQUIRED')]), policy, config, observed()),
  ]) {
    assert.equal(result.state, 'hold');
    assert.equal(result.effect_authorized, false);
  }
});

test('duplicate queued job evidence cannot impersonate another execution', () => {
  const duplicates: GcpRunnerJobObservation[] = [
    {
      repository,
      complete: true,
      jobs: [observed()[0]!.jobs[0]!, observed()[0]!.jobs[0]!],
    },
  ];
  const result = planGcpRunnerLeases(authority([work('EXECUTING')]), policy, config, duplicates);
  assert.equal(result.state, 'hold');
  if (result.state === 'hold') {
    assert.equal(result.reason, 'DUPLICATE_GITHUB_JOB_OBSERVATION');
  }
});


test('two simultaneous execution claims cannot overcommit the one-host warm pool', () => {
  const secondLaunch = {
    ...launch,
    job_id: launch.job_id + 1,
    runner_label: 'overcenter-gcp-warm-12345-verification-2',
  };
  const secondWork = {
    ...work('EXECUTING', { gcp_runner_job: secondLaunch }, 'second'),
    run_id: 'run-second',
  };
  const result = planGcpRunnerLeases(
    authority([work('EXECUTING'), secondWork]),
    { ...policy, eligible_obligation_ids: ['eligible', 'second'] },
    config,
    [{ ...observed()[0]!, jobs: [observed()[0]!.jobs[0]!, {
      id: secondLaunch.job_id,
      status: 'queued',
      labels: ['self-hosted', secondLaunch.runner_label],
    }] }],
  );
  assert.equal(result.state, 'hold');
  if (result.state === 'hold') {
    assert.equal(result.reason, 'CONCURRENT_EXECUTIONS_EXCEED_WARM_POOL_CAPACITY');
    assert.equal(result.effect_authorized, false);
  }
});
