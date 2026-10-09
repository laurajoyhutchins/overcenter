import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RUNNER_EXECUTION_LEASE_SCHEMA,
  parseRunnerExecutionLease,
  runnerExecutionMessage,
} from '../src/transport/gcp-runner-launcher.ts';
import {
  runnerContainerSpec,
  verifyRunnerContainerTeardown,
  warmRunnerAgentEnvironment,
} from '../src/transport/gce-runner-agent.ts';

const lease = {
  schema: RUNNER_EXECUTION_LEASE_SCHEMA,
  repository: 'laurajoyhutchins/arcata',
  repository_id: 1_402_666_660,
  owner_id: 219_002_713,
  job_id: 111_891_233_183,
  runner_label: 'overcenter-gcp-warm-123-check',
} as const;

const runnerImage =
  'us-west1-docker.pkg.dev/project-6b810532-a302-48dc-b56/cloud-run-source-deploy/overcenter-gcp-runner@sha256:' +
  'a'.repeat(64);

test('execution lease transport rejects schema drift and unexpected authority fields', () => {
  assert.deepEqual(parseRunnerExecutionLease(lease), lease);
  assert.throws(
    () =>
      parseRunnerExecutionLease({
        ...lease,
        schema: 'overcenter-github-runner-execution-lease/v2',
      }),
    /schema mismatch/,
  );
  assert.throws(
    () => parseRunnerExecutionLease({ ...lease, candidate_sha: 'a'.repeat(40) }),
    /unexpected runner execution lease key/,
  );
});

test('warm-pool message carries the exact immutable execution lease', () => {
  const message = runnerExecutionMessage(parseRunnerExecutionLease(lease));
  assert.equal(message.attributes.schema, RUNNER_EXECUTION_LEASE_SCHEMA);
  assert.equal(message.attributes.repository_id, String(lease.repository_id));
  assert.equal(message.attributes.job_id, String(lease.job_id));
  assert.deepEqual(
    parseRunnerExecutionLease(JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'))),
    lease,
  );
});

test('warm agent requires immutable runner image and bounded host work root', () => {
  const environment = warmRunnerAgentEnvironment({
    GCP_PROJECT_ID: 'project-6b810532-a302-48dc-b56',
    OVERCENTER_RUNNER_SUBSCRIPTION: 'overcenter-gce-runners',
    OVERCENTER_RUNNER_IMAGE: runnerImage,
    OVERCENTER_RUNNER_WORK_ROOT: '/var/lib/overcenter-runner/jobs',
  });
  assert.equal(environment.runnerImage, runnerImage);
  assert.throws(
    () =>
      warmRunnerAgentEnvironment({
        GCP_PROJECT_ID: 'project-6b810532-a302-48dc-b56',
        OVERCENTER_RUNNER_SUBSCRIPTION: 'overcenter-gce-runners',
        OVERCENTER_RUNNER_IMAGE: runnerImage.replace(/@sha256:.+$/, ':latest'),
        OVERCENTER_RUNNER_WORK_ROOT: '/var/lib/overcenter-runner/jobs',
      }),
    /must be immutable/,
  );
});

test('user runner container remains isolated from host authority', () => {
  const environment = warmRunnerAgentEnvironment({
    GCP_PROJECT_ID: 'project-6b810532-a302-48dc-b56',
    OVERCENTER_RUNNER_SUBSCRIPTION: 'overcenter-gce-runners',
    OVERCENTER_RUNNER_IMAGE: runnerImage,
    OVERCENTER_RUNNER_WORK_ROOT: '/var/lib/overcenter-runner/jobs',
  });
  const spec = runnerContainerSpec(
    environment,
    parseRunnerExecutionLease(lease),
    '/var/lib/overcenter-runner/jobs/111891233183-message',
  );
  const host = spec.HostConfig as {
    NetworkMode: string;
    Binds: string[];
    Dns: string[];
  };
  assert.equal(host.NetworkMode, 'bridge');
  assert.deepEqual(host.Dns, ['8.8.8.8', '8.8.4.4']);
  assert.deepEqual(host.Binds, ['/var/lib/overcenter-runner/jobs/111891233183-message:/workspace']);
  assert.equal(JSON.stringify(spec).includes('/var/run/docker.sock'), false);
  assert.equal(JSON.stringify(spec).includes('GOOGLE_APPLICATION_CREDENTIALS'), false);
});

test('warm host startup grants Docker authority only to the trusted agent and blocks metadata', () => {
  const startup = readFileSync(
    new URL('../infra/gcp/start-runner-warm-host.sh', import.meta.url),
    'utf8',
  );
  assert.match(startup, /iptables -I DOCKER-USER 1 -d 169\.254\.169\.254\/32 -j REJECT/);
  assert.match(startup, /--volume \/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  assert.match(startup, /src\/transport\/gce-runner-agent\.ts/);
  assert.match(startup, /registry_host\(\)/);
  assert.match(startup, /--registries="\$REGISTRIES"/);
  assert.doesNotMatch(startup, /--registries=us-west1-docker\.pkg\.dev/);
  assert.doesNotMatch(startup, /generate-jitconfig/);
});

test('runner teardown requires an independent Docker inspect 404 before ACK eligibility', async () => {
  const id = 'a'.repeat(64);
  const calls: string[] = [];
  await verifyRunnerContainerTeardown(id, async (method, path) => {
    calls.push(method + ' ' + path);
    return { statusCode: method === 'DELETE' ? 204 : 404, body: Buffer.alloc(0) };
  });
  assert.deepEqual(calls, [
    'DELETE /v1.45/containers/' + id + '?force=1',
    'GET /v1.45/containers/' + id + '/json',
  ]);
});

test('ambiguous Docker delete can reconcile to independently verified absence', async () => {
  const id = 'b'.repeat(64);
  let reads = 0;
  await verifyRunnerContainerTeardown(id, async (method) => {
    if (method === 'DELETE') throw new Error('connection reset after send');
    reads += 1;
    return { statusCode: 404, body: Buffer.alloc(0) };
  });
  assert.equal(reads, 1);
});

test('failed Docker cleanup cannot silently acknowledge a runner lease', async () => {
  const id = 'c'.repeat(64);
  for (const status of [200, 500]) {
    await assert.rejects(
      verifyRunnerContainerTeardown(id, async (method) => ({
        statusCode: method === 'DELETE' ? 204 : status,
        body: Buffer.alloc(0),
      })),
      /WARM_RUNNER_CONTAINER_TEARDOWN_UNVERIFIED/,
    );
  }
  await assert.rejects(
    verifyRunnerContainerTeardown(id, async (method) => {
      if (method === 'GET') throw new Error('daemon unavailable');
      return { statusCode: 204, body: Buffer.alloc(0) };
    }),
    /daemon unavailable/,
  );
});

test('runner teardown rejects injected or ambiguous Docker identities', async () => {
  await assert.rejects(
    verifyRunnerContainerTeardown('../../other', async () => ({
      statusCode: 404,
      body: Buffer.alloc(0),
    })),
    /Docker container id/,
  );
});
