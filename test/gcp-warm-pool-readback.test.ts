import assert from 'node:assert/strict';
import test from 'node:test';

import { observeGcpWarmPoolReadback } from '../src/providers/gcp/warm-pool-readback.ts';
import type { GcpJsonGet } from '../src/providers/gcp/rest.ts';

const target = {
  project: 'demo-project',
  zone: 'us-west1-a',
  mig: 'overcenter-gce-runners',
  autoscaler: 'overcenter-gce-runners-g2ow',
  subscription: 'overcenter-gce-runners',
  stabilization_seconds: 2700,
  source_sha: 'a'.repeat(40),
};

const root = 'https://www.googleapis.com/compute/v1/projects/demo-project/zones/us-west1-a';

function reader(denied = false): GcpJsonGet {
  return (_token, request) => {
    if (denied) throw new Error('HTTP 403');
    if (request.path.includes('/autoscalers/')) {
      return {
        kind: 'compute#autoscaler',
        id: 'auto-123',
        name: target.autoscaler,
        zone: root,
        target: root + '/instanceGroupManagers/' + target.mig,
        status: 'ACTIVE',
        autoscalingPolicy: {
          minNumReplicas: 0,
          maxNumReplicas: 1,
          mode: 'ON',
          stabilizationPeriodSec: 2700,
          customMetricUtilizations: [
            {
              metric: 'pubsub.googleapis.com/subscription/num_undelivered_messages',
              filter:
                'resource.type="pubsub_subscription" AND resource.labels.subscription_id="overcenter-gce-runners"',
              singleInstanceAssignment: 1,
            },
          ],
        },
      };
    }
    return {
      kind: 'compute#instanceGroupManager',
      id: 'mig-123',
      name: target.mig,
      zone: root,
      targetSize: 0,
      status: { isStable: true, versionTarget: { isReached: true } },
    };
  };
}

test('readback produces a truthful policy receipt without declaring physical zero', () => {
  const result = observeGcpWarmPoolReadback('token', target, {
    get: reader(),
    clock: () => '2026-10-09T19:00:00Z',
  });
  assert.equal(result.observation, 'observed');
  assert.equal(result.policy, 'matches');
  assert.equal(result.capacity, 'target-zero-stable');
  assert.deepEqual(result.observed_provider_ids, { mig: 'mig-123', autoscaler: 'auto-123' });
  assert.equal(result.actual_instances_verified_absent, false);
  assert.equal(result.pubsub_ack_verified, false);
  assert.equal(result.host_teardown_verified, false);
  assert.equal(result.effect_authorized, false);
  assert.equal(JSON.stringify(result).includes('token'), false);
});

test('permission denied is indeterminate and never declares absence', () => {
  const result = observeGcpWarmPoolReadback('token', target, {
    get: reader(true),
  });
  assert.equal(result.observation, 'hold');
  assert.equal(result.policy, 'unknown');
  assert.equal(result.capacity, 'unknown');
  assert.equal(result.actual_instances_verified_absent, false);
  assert.equal(result.effect_authorized, false);
});

test('wrong source, project and policy are rejected before any provider call', () => {
  let calls = 0;
  const get: GcpJsonGet = () => {
    calls += 1;
    throw new Error('unexpected');
  };
  for (const variant of [
    { source_sha: 'not-a-sha' },
    { project: '../different' },
    { zone: 'us-west1-a/other' },
    { stabilization_seconds: 1 },
  ]) {
    assert.throws(
      () => observeGcpWarmPoolReadback('token', { ...target, ...variant }, { get }),
      /GCP_WARM_POOL_READBACK_TARGET_INVALID/,
    );
  }
  assert.equal(calls, 0);
});
