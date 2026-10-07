import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  deriveGitHubWebhookSecret,
  isWorkflowJobWakeHint,
  parseRunnerAutoscalerConfig,
  verifyGitHubWebhookSignature,
} from '../src/transport/gcp-runner-autoscaler.ts';

const config = parseRunnerAutoscalerConfig({
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
  ],
});

const queuedPayload = {
  action: 'queued',
  repository: {
    id: 1_402_666_660,
    full_name: 'laurajoyhutchins/arcata',
    owner: { id: 219_002_713 },
  },
  workflow_job: {
    id: 123,
    status: 'queued',
    labels: ['self-hosted', 'overcenter-gcp'],
  },
};

test('GitHub webhook signatures are exact HMAC evidence', () => {
  const secret = deriveGitHubWebhookSecret('private-key-fixture');
  const body = Buffer.from(JSON.stringify(queuedPayload));
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(verifyGitHubWebhookSignature(body, signature, secret), true);
  assert.equal(
    verifyGitHubWebhookSignature(Buffer.from(body.toString('utf8') + ' '), signature, secret),
    false,
  );
  assert.equal(verifyGitHubWebhookSignature(body, undefined, secret), false);
});

test('only queued admitted GCP workflow jobs can wake observation', () => {
  assert.equal(isWorkflowJobWakeHint(queuedPayload, config), true);
  assert.equal(isWorkflowJobWakeHint({ ...queuedPayload, action: 'completed' }, config), false);
  assert.equal(
    isWorkflowJobWakeHint(
      {
        ...queuedPayload,
        repository: { ...queuedPayload.repository, id: 999 },
      },
      config,
    ),
    false,
  );
  assert.equal(
    isWorkflowJobWakeHint(
      {
        ...queuedPayload,
        workflow_job: { ...queuedPayload.workflow_job, status: 'in_progress' },
      },
      config,
    ),
    false,
  );
  assert.equal(
    isWorkflowJobWakeHint(
      {
        ...queuedPayload,
        workflow_job: {
          ...queuedPayload.workflow_job,
          labels: ['self-hosted', 'overcenter-gcp', 'overcenter-gcp-specific'],
        },
      },
      config,
    ),
    false,
  );
});

test('webhook secret derivation is stable and key-bound', () => {
  assert.equal(
    deriveGitHubWebhookSecret('private-key-fixture'),
    deriveGitHubWebhookSecret('private-key-fixture'),
  );
  assert.notEqual(
    deriveGitHubWebhookSecret('private-key-fixture'),
    deriveGitHubWebhookSecret('private-key-fixture-2'),
  );
});
