import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  isEligibleRunnerJob,
  mapBounded,
  parseRunnerAutoscalerConfig,
  runnerSchedulingLabel,
} from '../src/transport/gcp-runner-autoscaler.ts';

const validConfig = {
  schema: 'overcenter-gcp-runner-autoscaler/v1',
  poll_interval_ms: 10_000,
  redispatch_after_ms: 600_000,
  runner_label: 'overcenter-gcp',
  repositories: [
    {
      full_name: 'laurajoyhutchins/arcata',
      repository_id: 1_402_666_660,
      owner_id: 219_002_713,
    },
    {
      full_name: 'laurajoyhutchins/azelficoast',
      repository_id: 1_384_608_118,
      owner_id: 219_002_713,
    },
    {
      full_name: 'laurajoyhutchins/laura-dev-tools',
      repository_id: 1_383_875_536,
      owner_id: 219_002_713,
    },
    {
      full_name: 'laurajoyhutchins/overcenter',
      repository_id: 1_354_872_053,
      owner_id: 219_002_713,
    },
  ],
};

test('autoscaler config preserves immutable repository identities', () => {
  const parsed = parseRunnerAutoscalerConfig(validConfig);
  assert.equal(parsed.repositories[0]?.repository_id, 1_402_666_660);
  assert.equal(parsed.repositories[0]?.owner_id, 219_002_713);
  assert.equal(parsed.repositories[1]?.repository_id, 1_384_608_118);
  assert.equal(parsed.repositories[1]?.owner_id, 219_002_713);
  assert.equal(parsed.repositories[2]?.repository_id, 1_383_875_536);
  assert.equal(parsed.repositories[2]?.owner_id, 219_002_713);
  assert.equal(parsed.repositories[3]?.repository_id, 1_354_872_053);
  assert.equal(parsed.repositories[3]?.owner_id, 219_002_713);
});

test('autoscaler config rejects the retired GitHub-hosted dispatch layer', () => {
  assert.throws(
    () =>
      parseRunnerAutoscalerConfig({
        ...validConfig,
        dispatch: {
          repository: 'laurajoyhutchins/overcenter',
          workflow: 'gcp-runner-launch.yml',
        },
      }),
    /unexpected runner autoscaler config key: dispatch/,
  );
});

test('autoscaler config rejects duplicate repository authorities', () => {
  const duplicate = {
    ...validConfig,
    repositories: [...validConfig.repositories, validConfig.repositories[0]],
  };
  assert.throws(() => parseRunnerAutoscalerConfig(duplicate), /duplicate repository binding/);
});

test('queued jobs resolve exactly one GCP scheduling label', () => {
  const exact = {
    id: 1,
    status: 'queued',
    labels: ['self-hosted', 'overcenter-gcp-123456-check'],
  };
  assert.equal(runnerSchedulingLabel(exact, 'overcenter-gcp'), 'overcenter-gcp-123456-check');
  assert.equal(isEligibleRunnerJob(exact, 'overcenter-gcp'), true);

  assert.equal(
    runnerSchedulingLabel(
      {
        id: 2,
        status: 'queued',
        labels: ['self-hosted', 'overcenter-gcp'],
      },
      'overcenter-gcp',
    ),
    'overcenter-gcp',
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 3,
        status: 'in_progress',
        labels: ['self-hosted', 'overcenter-gcp-123456-check'],
      },
      'overcenter-gcp',
    ),
    false,
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 4,
        status: 'queued',
        labels: ['self-hosted', 'overcenter-gcp', 'overcenter-gcp-123456-check'],
      },
      'overcenter-gcp',
    ),
    false,
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 5,
        status: 'queued',
        labels: ['self-hosted', 'overcenter-gcpish'],
      },
      'overcenter-gcp',
    ),
    false,
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 6,
        status: 'queued',
        labels: ['ubuntu-latest'],
      },
      'overcenter-gcp',
    ),
    false,
  );
});

test('runner image pins rustup bootstrap for repository verification', () => {
  const dockerfile = readFileSync(
    new URL('../infra/gcp-runner-image/Dockerfile', import.meta.url),
    'utf8',
  );
  assert.match(dockerfile, /ARG RUSTUP_VERSION=1\.28\.2/);
  assert.match(
    dockerfile,
    /ARG RUSTUP_SHA256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c/,
  );
  assert.match(dockerfile, /--default-toolchain none/);
  assert.doesNotMatch(dockerfile, /docker\.sock|--privileged/);
});

test('deployment lane keeps only the latest exact substrate revision', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/gcp-runner-autoscaler-deploy.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /group: deploy-gcp-runner-autoscaler/);
  assert.match(workflow, /cancel-in-progress: true/);
});

test('autoscaler deployment uses a unique exact-job GCP runner', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/gcp-runner-autoscaler-deploy.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /runs-on: \[self-hosted, "overcenter-gcp-\$\{\{ github\.run_id \}\}-deploy-\$\{\{ github\.run_attempt \}\}"\]/,
  );
  assert.doesNotMatch(workflow, /runs-on: ubuntu-/);
  assert.match(workflow, /cancel-in-progress: true/);
});

test('bounded runner work preserves scan order without serializing independent jobs', async () => {
  let active = 0;
  let peak = 0;
  const visited: number[] = [];
  const result = await mapBounded([0, 1, 2, 3, 4, 5, 6], 3, async (job) => {
    active += 1;
    peak = Math.max(peak, active);
    visited.push(job);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return job * 2;
  });
  assert.deepEqual(result, [0, 2, 4, 6, 8, 10, 12]);
  assert.deepEqual(visited.slice(0, 3), [0, 1, 2]);
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test('bounded runner work fails closed on invalid concurrency and propagates errors', async () => {
  await assert.rejects(
    mapBounded([1], 0, async (value) => value),
    /bounded map concurrency must be a positive integer/,
  );
  await assert.rejects(
    mapBounded([1], Number.POSITIVE_INFINITY, async (value) => value),
    /bounded map concurrency must be a positive integer/,
  );
  await assert.rejects(
    mapBounded([1, 2], 1, async (value) => {
      if (value === 2) throw new Error('independent provider failure');
      return value;
    }),
    /independent provider failure/,
  );
  assert.deepEqual(await mapBounded([], 2, async (value: number) => value), []);
});

test('bounded runner work drains in-flight requests before returning a failed scan', async () => {
  let releaseSlow: (() => void) | undefined;
  let slowFinished = false;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const scan = mapBounded([1, 2, 3], 2, async (job) => {
    if (job === 1) throw new Error('GitHub lookup failed');
    await slow;
    slowFinished = true;
    return job;
  });
  let settled = false;
  const observed = scan.catch((error: unknown) => {
    settled = true;
    throw error;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'the failing scan must still await its in-flight peer');
  assert.equal(slowFinished, false);
  assert.ok(releaseSlow);
  releaseSlow();
  await assert.rejects(observed, /GitHub lookup failed/);
  assert.equal(slowFinished, true);
});
