import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  githubConditionalJson,
  isEligibleRunnerJob,
  parseRunnerAutoscalerConfig,
  runnerSchedulingLabel,
} from '../src/transport/gcp-runner-autoscaler.ts';

const validConfig = {
  schema: 'overcenter-gcp-runner-autoscaler/v1',
  poll_interval_ms: 2_000,
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
  assert.equal(parsed.repositories[2]?.repository_id, 1_354_872_053);
  assert.equal(parsed.repositories[2]?.owner_id, 219_002_713);
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

test('bootstrap deployment uses the separate ARM64 hosted pool', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/gcp-runner-autoscaler-deploy.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /runs-on: ubuntu-24\.04-arm/);
  assert.match(workflow, /cancel-in-progress: true/);
});


test('conditional GitHub reads reuse authenticated ETag state on 304', async () => {
  const originalFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  let call = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(init ?? {});
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ workflow_runs: [{ id: 7, status: 'queued' }] }), {
        status: 200,
        headers: { etag: '"fixture-etag"' },
      });
    }
    return new Response(null, { status: 304 });
  }) as typeof fetch;

  try {
    const path = '/repos/fixture/example/actions/runs?status=queued&per_page=100&page=1';
    const first = await githubConditionalJson(path, 'fixture-token');
    const second = await githubConditionalJson(path, 'fixture-token');
    assert.deepEqual(second, first);
    assert.equal(new Headers(requests[1]?.headers).get('if-none-match'), '"fixture-etag"');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('production runner autoscaler polls every two seconds', () => {
  const config = JSON.parse(
    readFileSync(new URL('../config/gcp-runner-autoscaler.json', import.meta.url), 'utf8'),
  ) as { poll_interval_ms?: number };
  assert.equal(config.poll_interval_ms, 2_000);
});
