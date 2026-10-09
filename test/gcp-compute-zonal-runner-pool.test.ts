import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGcpWarmPool,
  GCP_ZONAL_AUTOSCALER_SCHEMA_SHA256,
  GCP_ZONAL_MIG_SCHEMA_SHA256,
  observeCertifiedGcpZonalAutoscaler,
  observeCertifiedGcpZonalMig,
} from '../src/providers/gcp/compute-zonal-runner-pool.ts';
import type { GcpJsonGet } from '../src/providers/gcp/rest.ts';

const project = 'demo-project';
const zone = 'us-west1-a';
const mig = 'overcenter-gce-runners';
const autoscaler = 'overcenter-gce-runners-g2ow';
const subscription = 'overcenter-gce-runners';
const root = `https://www.googleapis.com/compute/v1/projects/${project}/zones/${zone}`;

const migCoordinate = { project, zone, mig };
const autoscalerCoordinate = { project, zone, mig, autoscaler };

function migResource(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'compute#instanceGroupManager',
    id: '12345',
    name: mig,
    zone: root,
    selfLink: `${root}/instanceGroupManagers/${mig}`,
    targetSize: 0,
    fingerprint: 'mig-fingerprint',
    status: { isStable: true, versionTarget: { isReached: true } },
    untrusted_description: 'not-certified',
    ...overrides,
  };
}

function autoscalerResource(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'compute#autoscaler',
    id: '67890',
    name: autoscaler,
    zone: root,
    selfLink: `${root}/autoscalers/${autoscaler}`,
    target: `${root}/instanceGroupManagers/${mig}`,
    status: 'ACTIVE',
    autoscalingPolicy: {
      minNumReplicas: 0,
      maxNumReplicas: 1,
      stabilizationPeriodSec: 2700,
      coolDownPeriodSec: 60,
      mode: 'ON',
      customMetricUtilizations: [{
        metric: 'pubsub.googleapis.com/subscription/num_undelivered_messages',
        filter: `resource.type="pubsub_subscription" AND resource.labels.subscription_id="${subscription}"`,
        singleInstanceAssignment: 1,
      }],
    },
    other_untrusted_field: 'not-certified',
    ...overrides,
  };
}

test('certified GCE MIG and autoscaler read exact zonal endpoints without shell execution', () => {
  const requests: Parameters<GcpJsonGet>[1][] = [];
  const get: GcpJsonGet = (_token, request) => {
    requests.push(request);
    return request.path.includes('/autoscalers/') ? autoscalerResource() : migResource();
  };
  const options = { get, clock: () => '2026-10-09T16:00:00.000Z' };
  const m = observeCertifiedGcpZonalMig('token', migCoordinate, options);
  const a = observeCertifiedGcpZonalAutoscaler('token', autoscalerCoordinate, options);
  assert.equal(m.state, 'observed');
  assert.equal(a.state, 'observed');
  assert.deepEqual(requests, [
    {
      authority_host: 'compute.googleapis.com',
      path: `/compute/v1/projects/${project}/zones/${zone}/instanceGroupManagers/${mig}`,
      headers: { Accept: 'application/json' },
    },
    {
      authority_host: 'compute.googleapis.com',
      path: `/compute/v1/projects/${project}/zones/${zone}/autoscalers/${autoscaler}`,
      headers: { Accept: 'application/json' },
    },
  ]);
  if (m.state !== 'observed' || a.state !== 'observed') return;
  assert.equal(m.evidence.schema_sha256, GCP_ZONAL_MIG_SCHEMA_SHA256);
  assert.equal(a.evidence.schema_sha256, GCP_ZONAL_AUTOSCALER_SCHEMA_SHA256);
  assert.equal(m.evidence.negative_evidence_authoritative, false);
  assert.equal(a.evidence.negative_evidence_authoritative, false);
  assert.equal(m.evidence.observed_at, options.clock());
  assert.equal(a.evidence.observed_at, options.clock());
  assert.equal(m.evidence.provider_id, '12345');
  assert.equal(a.evidence.provider_id, '67890');
  assert.equal(JSON.stringify(m.value).includes('not-certified'), false);
  assert.equal(JSON.stringify(a.value).includes('not-certified'), false);
  assert.deepEqual(assessGcpWarmPool(m, a, { subscription, stabilization_seconds: 2700 }), {
    state: 'observed',
    policy: 'matches',
    capacity: 'target-zero-stable',
    actual_instances_verified_absent: false,
  });
});

test('zero target never purports to prove there are no actual instances', () => {
  const a = observeCertifiedGcpZonalAutoscaler('token', autoscalerCoordinate, {
    get: () => autoscalerResource(),
  });
  for (const [targetSize, capacity] of [
    [0, 'target-zero-stable'],
    [1, 'target-one-stable'],
    [2, 'out-of-bounds'],
  ] as const) {
    const m = observeCertifiedGcpZonalMig('token', migCoordinate, {
      get: () => migResource({ targetSize }),
    });
    const assessment = assessGcpWarmPool(m, a, { subscription, stabilization_seconds: 2700 });
    assert.equal(assessment.state, 'observed');
    if (assessment.state === 'observed') {
      assert.equal(assessment.capacity, capacity);
      assert.equal(assessment.actual_instances_verified_absent, false);
    }
  }
  const changing = observeCertifiedGcpZonalMig('token', migCoordinate, {
    get: () => migResource({ status: { isStable: false, versionTarget: { isReached: false } } }),
  });
  const result = assessGcpWarmPool(changing, a, { subscription, stabilization_seconds: 2700 });
  assert.equal(result.state, 'observed');
  if (result.state === 'observed') assert.equal(result.capacity, 'changing');
});

test('wrong resource identity and forged self-link origin fail closed', () => {
  for (const body of [
    migResource({ name: 'other-group' }),
    migResource({ zone: root.replace(project, 'foreign-project') }),
    migResource({ selfLink: `https://evil.invalid/compute/v1/projects/${project}/zones/${zone}/instanceGroupManagers/${mig}` }),
    migResource({ targetSize: -1 }),
  ]) {
    const result = observeCertifiedGcpZonalMig('token', migCoordinate, { get: () => body });
    assert.equal(result.state, 'indeterminate');
  }
  for (const body of [
    autoscalerResource({ name: 'other-autoscaler' }),
    autoscalerResource({ target: `${root}/instanceGroupManagers/other` }),
    autoscalerResource({ zone: root.replace(zone, 'us-west1-b') }),
    autoscalerResource({ autoscalingPolicy: {
      minNumReplicas: 3, maxNumReplicas: 1, stabilizationPeriodSec: 2700,
    } }),
  ]) {
    const result = observeCertifiedGcpZonalAutoscaler('token', autoscalerCoordinate, {
      get: () => body,
    });
    assert.equal(result.state, 'indeterminate');
  }
});

test('additional autoscaler signals are observed as drift, never silently ignored', () => {
  const m = observeCertifiedGcpZonalMig('token', migCoordinate, { get: () => migResource() });
  for (const policyChange of [
    { minNumReplicas: 1 },
    { maxNumReplicas: 2 },
    { mode: 'OFF' },
    { cpuUtilization: { utilizationTarget: 0.6 } },
    { scalingSchedules: { night: { minRequiredReplicas: 1 } } },
    { customMetricUtilizations: [
      { metric: 'other', filter: 'other', singleInstanceAssignment: 1 },
    ] },
    { customMetricUtilizations: [] },
  ]) {
    const base = autoscalerResource().autoscalingPolicy;
    const a = observeCertifiedGcpZonalAutoscaler('token', autoscalerCoordinate, {
      get: () => autoscalerResource({ autoscalingPolicy: { ...base, ...policyChange } }),
    });
    const assessment = assessGcpWarmPool(m, a, { subscription, stabilization_seconds: 2700 });
    assert.equal(assessment.state, 'observed');
    if (assessment.state === 'observed') assert.equal(assessment.policy, 'drift');
  }
});

test('separate readbacks cannot be combined across project or zone', () => {
  const m = observeCertifiedGcpZonalMig('token', migCoordinate, { get: () => migResource() });
  const otherZone = 'us-west1-b';
  const otherRoot = root.replace(zone, otherZone);
  const a = observeCertifiedGcpZonalAutoscaler(
    'token',
    { ...autoscalerCoordinate, zone: otherZone },
    {
      get: () => autoscalerResource({
        zone: otherRoot,
        selfLink: `${otherRoot}/autoscalers/${autoscaler}`,
        target: `${otherRoot}/instanceGroupManagers/${mig}`,
      }),
    },
  );
  assert.equal(m.state, 'observed');
  assert.equal(a.state, 'observed');
  assert.deepEqual(assessGcpWarmPool(m, a, { subscription, stabilization_seconds: 2700 }), {
    state: 'indeterminate',
    reason: 'GCP_WARM_POOL_OBSERVATION_COORDINATE_MISMATCH',
    actual_instances_verified_absent: false,
  });
});

test('incomplete, invalid and denied readback remains indeterminate, never absence', () => {
  const denied: GcpJsonGet = () => { throw new Error('HTTP 403: compute.instanceGroupManagers.get denied'); };
  const m = observeCertifiedGcpZonalMig('token', migCoordinate, { get: denied });
  assert.deepEqual(m, {
    state: 'indeterminate',
    observation_error: 'HTTP 403: compute.instanceGroupManagers.get denied',
  });
  const a = observeCertifiedGcpZonalAutoscaler('token', autoscalerCoordinate, {
    get: () => ({ ...autoscalerResource(), autoscalingPolicy: { minNumReplicas: '0' } }),
  });
  assert.equal(a.state, 'indeterminate');
  assert.deepEqual(
    assessGcpWarmPool(m, a, { subscription, stabilization_seconds: 2700 }),
    {
      state: 'indeterminate',
      reason: 'HTTP 403: compute.instanceGroupManagers.get denied',
      actual_instances_verified_absent: false,
    },
  );
});

test('invalid coordinate is refused before provider access', () => {
  let called = false;
  const result = observeCertifiedGcpZonalMig(
    'token',
    { ...migCoordinate, mig: '../unauthorized' },
    { get: () => { called = true; return migResource(); } },
  );
  assert.equal(result.state, 'indeterminate');
  assert.equal(called, false);
});
