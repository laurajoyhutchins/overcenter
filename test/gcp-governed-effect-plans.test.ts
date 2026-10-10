import assert from 'node:assert/strict';
import test from 'node:test';

import { observeCertifiedGcpCloudRunService } from '../src/providers/gcp/cloud-run-service.ts';
import { planGcpCloudRunRevision } from '../src/providers/gcp/governed-effect-plans.ts';

const coordinate = { project: 'demo-project', location: 'us-west1', service: 'runner' };
const name = 'projects/demo-project/locations/us-west1/services/runner';
const goal = {
  coordinate,
  expected_uid: 'svc-uid',
  expected_etag: 'etag-123',
  desired_revision: 'runner-00002',
};

function observed(overrides: Record<string, unknown> = {}) {
  return observeCertifiedGcpCloudRunService('token', coordinate, {
    get: () => ({
      name,
      uid: 'svc-uid',
      etag: 'etag-123',
      generation: '2',
      observedGeneration: '2',
      reconciling: false,
      terminalCondition: { state: 'CONDITION_SUCCEEDED' },
      latestCreatedRevision: name + '/revisions/runner-00001',
      latestReadyRevision: name + '/revisions/runner-00001',
      ...overrides,
    }),
  });
}

test('Cloud Run plan binds change proposal to exact UID, etag and generation, never dispatches', () => {
  const result = planGcpCloudRunRevision(goal, observed());
  assert.equal(result.state, 'requires-admission');
  if (result.state !== 'requires-admission') return;
  assert.equal(result.effect_authorized, false);
  assert.equal(result.target, name);
  assert.match(result.proposal_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(planGcpCloudRunRevision(goal, observed()), result);
});

test('Cloud Run plan declares convergence only after ready same-revision readback', () => {
  const revision = name + '/revisions/runner-00002';
  const result = planGcpCloudRunRevision(
    goal,
    observed({
      latestCreatedRevision: revision,
      latestReadyRevision: revision,
    }),
  );
  assert.deepEqual(result, {
    state: 'converged',
    revision,
    observed_generation: '2',
    effect_authorized: false,
  });
  for (const body of [
    { reconciling: true },
    { observedGeneration: '1' },
    { terminalCondition: { state: 'CONDITION_FAILED' } },
    { etag: 'different' },
    { uid: 'other' },
  ]) {
    const candidate = planGcpCloudRunRevision(goal, observed(body));
    assert.equal(candidate.state, 'hold');
    assert.equal(candidate.effect_authorized, false);
  }
});

test('unknown readback and forged coordinates can never authorize a Cloud Run effect', () => {
  assert.deepEqual(
    planGcpCloudRunRevision(goal, { state: 'indeterminate', observation_error: 'HTTP 403' }),
    { state: 'hold', reason: 'GCP_CLOUD_RUN_OBSERVATION_INDETERMINATE', effect_authorized: false },
  );
  const invalid = planGcpCloudRunRevision({ ...goal, desired_revision: 'run/other' }, observed());
  assert.equal(invalid.state, 'hold');
  const altered = planGcpCloudRunRevision({ ...goal, expected_etag: 'spoofed' }, observed());
  assert.equal(altered.state, 'hold');
});
