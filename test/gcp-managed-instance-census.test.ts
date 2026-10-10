import assert from 'node:assert/strict';
import test from 'node:test';

import {
  observeGcpManagedInstanceCensus,
  type GcpManagedInstancePostRequest,
} from '../src/providers/gcp/compute-managed-instance-census.ts';

const target = { project: 'demo-project', zone: 'us-west1-a', mig: 'overcenter-gce-runners' };
const prefix =
  'https://www.googleapis.com/compute/v1/projects/demo-project/zones/us-west1-a/instances/';

test('read-only POST observes a complete empty managed-instance membership set', () => {
  const requests: GcpManagedInstancePostRequest[] = [];
  const result = observeGcpManagedInstanceCensus('token', target, {
    clock: () => '2026-10-09T20:00:00Z',
    post: (_token, request) => {
      requests.push(request);
      return { managedInstances: [], untrusted: 'never-certified' };
    },
  });
  assert.equal(result.state, 'observed');
  if (result.state !== 'observed') return;
  assert.deepEqual(result.instances, []);
  assert.equal(result.evidence.managed_instance_count, 0);
  assert.equal(result.evidence.zero_managed_membership_observed, true);
  assert.equal(result.evidence.negative_evidence_authoritative, false);
  assert.equal(result.evidence.physical_zero_settled, false);
  assert.equal(result.evidence.observed_at, '2026-10-09T20:00:00Z');
  assert.equal(JSON.stringify(result).includes('untrusted'), false);
  assert.deepEqual(requests, [
    {
      authority_host: 'compute.googleapis.com',
      method: 'POST',
      path: '/compute/v1/projects/demo-project/zones/us-west1-a/instanceGroupManagers/overcenter-gce-runners/listManagedInstances',
      body: null,
    },
  ]);
});

test('present managed instance has exact canonical instance identity', () => {
  const result = observeGcpManagedInstanceCensus('token', target, {
    post: () => ({
      managedInstances: [{ instance: prefix + 'runner-001', id: '123', currentAction: 'NONE' }],
      secretMetadata: 'not-certified',
    }),
  });
  assert.equal(result.state, 'observed');
  if (result.state !== 'observed') return;
  assert.equal(result.instances.length, 1);
  assert.equal(result.evidence.zero_managed_membership_observed, false);
  assert.equal(JSON.stringify(result).includes('secretMetadata'), false);
});

test('pagination, missing member array, and forged origins never settle zero', () => {
  for (const response of [
    { nextPageToken: 'more' },
    { managedInstances: [], nextPageToken: 'more' },
    {
      managedInstances: [
        { instance: 'https://evil.invalid' + prefix.slice('https://www.googleapis.com'.length) },
      ],
    },
    { managedInstances: [{ instance: prefix + 'runner-001', currentAction: 3 }] },
  ]) {
    const result = observeGcpManagedInstanceCensus('token', target, { post: () => response });
    assert.equal(result.state, 'indeterminate');
  }
});

test('403 and invalid coordinates remain indeterminate, never call provider on bad target', () => {
  let calls = 0;
  const post = () => {
    calls++;
    return { managedInstances: [] };
  };
  assert.equal(
    observeGcpManagedInstanceCensus('token', { ...target, zone: '../zone' }, { post }).state,
    'indeterminate',
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    observeGcpManagedInstanceCensus('token', target, {
      post: () => {
        throw new Error('HTTP 403');
      },
    }),
    { state: 'indeterminate', observation_error: 'HTTP 403' },
  );
});
