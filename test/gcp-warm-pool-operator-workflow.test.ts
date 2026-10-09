import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/gcp-warm-pool-readback.yml', import.meta.url),
  'utf8',
);
const entrypoint = readFileSync(
  new URL('../src/providers/gcp/warm-pool-cli.ts', import.meta.url),
  'utf8',
);

test('readback workflow uses a separate observer, fixed main source and no administrator', () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /GCP_OBSERVER_SERVICE_ACCOUNT: overcenter-observer@/);
  assert.match(workflow, /token_format: access_token/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /test "\$GITHUB_ACTOR" = "laurajoyhutchins"/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/);
  assert.doesNotMatch(workflow, /overcenter-deployer@/);
  assert.doesNotMatch(workflow, /(?:gcloud|terraform)\s+(?:run\s+deploy|compute\s+instance-groups\s+managed\s+resize|apply)/);
});

test('operator pins exact resource coordinates and emits no false zero-state proof', () => {
  assert.match(entrypoint, /GCP_OBSERVER_ACCESS_TOKEN/);
  assert.match(entrypoint, /GCP_OBSERVER_UNTRUSTED_SOURCE_REVISION/);
  assert.match(entrypoint, /project-6b810532-a302-48dc-b56/);
  assert.match(entrypoint, /overcenter-gce-runners-g2ow/);
  assert.match(entrypoint, /stabilization_seconds: 2700/);
  assert.match(entrypoint, /flag: 'wx'/);
  assert.doesNotMatch(entrypoint, /start-instance|stop-instance|resize|set-autoscaling/);
});
