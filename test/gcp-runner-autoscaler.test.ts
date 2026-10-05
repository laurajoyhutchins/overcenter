import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEligibleRunnerJob,
  parseRunnerAutoscalerConfig,
} from '../src/transport/gcp-runner-autoscaler.ts';

const validConfig = {
  schema: 'overcenter-gcp-runner-autoscaler/v1',
  poll_interval_ms: 10_000,
  redispatch_after_ms: 600_000,
  runner_label: 'overcenter-gcp',
  dispatch: {
    repository: 'laurajoyhutchins/overcenter',
    repository_id: 1_354_872_053,
    owner_id: 219_002_713,
    workflow: 'gcp-runner-launch.yml',
    ref: 'work/gcp-cloud-run-cloud-sql-bootstrap',
  },
  repositories: [
    {
      full_name: 'laurajoyhutchins/arcata',
      repository_id: 1_402_666_660,
      owner_id: 219_002_713,
    },
  ],
};

test('autoscaler config preserves immutable repository identities', () => {
  const parsed = parseRunnerAutoscalerConfig(validConfig);
  assert.equal(parsed.dispatch.repository_id, 1_354_872_053);
  assert.equal(parsed.dispatch.owner_id, 219_002_713);
  assert.equal(parsed.repositories[0]?.repository_id, 1_402_666_660);
  assert.equal(parsed.repositories[0]?.owner_id, 219_002_713);
});

test('autoscaler config rejects duplicate repository authorities', () => {
  const duplicate = {
    ...validConfig,
    repositories: [
      ...validConfig.repositories,
      {
        full_name: 'laurajoyhutchins/arcata',
        repository_id: 1_402_666_660,
        owner_id: 219_002_713,
      },
    ],
  };
  assert.throws(() => parseRunnerAutoscalerConfig(duplicate), /duplicate repository binding/);
});

test('only queued self-hosted jobs with the GCP label are eligible', () => {
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 1,
        status: 'queued',
        labels: ['self-hosted', 'Linux', 'X64', 'overcenter-gcp'],
      },
      'overcenter-gcp',
    ),
    true,
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 2,
        status: 'in_progress',
        labels: ['self-hosted', 'overcenter-gcp'],
      },
      'overcenter-gcp',
    ),
    false,
  );
  assert.equal(
    isEligibleRunnerJob(
      {
        id: 3,
        status: 'queued',
        labels: ['ubuntu-latest'],
      },
      'overcenter-gcp',
    ),
    false,
  );
});
