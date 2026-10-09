import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function lifecycle(scenario: string): string[] {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      fileURLToPath(new URL('./fixtures/warm-runner-lifecycle.ts', import.meta.url)),
      fileURLToPath(new URL('../src/transport/gce-runner-agent.ts', import.meta.url)),
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        TEST_WARM_SCENARIO: scenario,
        GCP_PROJECT_ID: 'project-6b810532-a302-48dc-b56',
        OVERCENTER_RUNNER_SUBSCRIPTION: 'overcenter-gce-runners',
        OVERCENTER_RUNNER_IMAGE: 'test-image@sha256:' + 'a'.repeat(64),
        OVERCENTER_RUNNER_WORK_ROOT: '/var/lib/overcenter-runner/jobs',
      },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /TEST_END_OF_DELIVERY/);
  const output = result.stdout.split('\n').find((line) => line.startsWith('TEST_EVENTS='));
  assert.ok(output, result.stdout + result.stderr);
  return JSON.parse(output.slice('TEST_EVENTS='.length)) as string[];
}

for (const scenario of ['success', 'stale']) {
  test(
    scenario + ' delivery acknowledges only after container absence and workspace removal',
    () => {
      const events = lifecycle(scenario);
      assert.deepEqual(events.slice(-4), [
        'DELETE /v1.45/containers/overcenter-gcp-111891233183-gce-test-message?force=1',
        'GET /v1.45/containers/overcenter-gcp-111891233183-gce-test-message/json',
        'remove-workspace',
        'ack',
      ]);
      assert.equal(events.includes('write-jit'), scenario === 'success');
    },
  );
}

for (const scenario of [
  'delete-failure',
  'delete-transport-failure',
  'retained-container',
  'workspace-failure',
  'stale-delete-failure',
  'start-failure',
]) {
  test(scenario + ' attempts workspace removal and withholds acknowledgement', () => {
    const events = lifecycle(scenario);
    assert.ok(events.some((event) => event.startsWith('DELETE ')));
    assert.equal(events.at(-1), 'remove-workspace');
    assert.equal(events.includes('ack'), false);
  });
}
