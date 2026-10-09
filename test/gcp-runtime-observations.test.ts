import assert from 'node:assert/strict';
import test from 'node:test';

import {
  observeCertifiedGcpCloudRunRevision,
  observeCertifiedGcpSchedulerJob,
  observeCertifiedGcpSubscription,
} from '../src/providers/gcp/runtime-observations.ts';
import type { GcpJsonGet } from '../src/providers/gcp/rest.ts';

const project = 'demo-project';

test('Pub/Sub subscription GET pins identity and never claims ACK or backlog', () => {
  const seen: Parameters<GcpJsonGet>[1][] = [];
  const result = observeCertifiedGcpSubscription(
    'token',
    { project, subscription: 'runner-jobs' },
    {
      clock: () => '2026-10-09T19:00:00Z',
      get: (_token, request) => {
        seen.push(request);
        return {
          name: 'projects/demo-project/subscriptions/runner-jobs',
          topic: 'projects/demo-project/topics/runner-jobs',
          ackDeadlineSeconds: 60,
          unverified: 'never project',
        };
      },
    },
  );
  assert.equal(result.state, 'observed');
  if (result.state !== 'observed') return;
  assert.equal(result.evidence.negative_evidence_authoritative, false);
  assert.equal(result.evidence.observed_at, '2026-10-09T19:00:00Z');
  assert.equal(JSON.stringify(result).includes('unverified'), false);
  assert.equal(JSON.stringify(result).includes('acknowledged'), false);
  assert.deepEqual(seen, [
    {
      authority_host: 'pubsub.googleapis.com',
      path: '/v1/projects/demo-project/subscriptions/runner-jobs',
      headers: { Accept: 'application/json' },
    },
  ]);
});

test('Scheduler GET refuses wrong state and resource identity', () => {
  const coordinate = { project, location: 'us-west1', job: 'reconcile' };
  const original = {
    name: 'projects/demo-project/locations/us-west1/jobs/reconcile',
    state: 'ENABLED',
    lastAttemptTime: '2026-10-09T18:00:00Z',
  };
  const good = observeCertifiedGcpSchedulerJob('token', coordinate, { get: () => original });
  assert.equal(good.state, 'observed');
  for (const body of [
    { ...original, state: 'BROKEN' },
    { ...original, name: 'projects/demo-project/locations/us-west1/jobs/other' },
  ]) {
    assert.equal(
      observeCertifiedGcpSchedulerJob('token', coordinate, { get: () => body }).state,
      'indeterminate',
    );
  }
});

test('Cloud Run revision binds both revision and parent service', () => {
  const coordinate = { project, location: 'us-west1', service: 'runner', revision: 'runner-00001' };
  const body = {
    name: 'projects/demo-project/locations/us-west1/services/runner/revisions/runner-00001',
    service: 'projects/demo-project/locations/us-west1/services/runner',
    uid: 'rev-uid-1',
    generation: '1',
    conditions: [{ type: 'Ready', state: 'CONDITION_SUCCEEDED' }],
    credential: 'not-certified',
  };
  const good = observeCertifiedGcpCloudRunRevision('token', coordinate, { get: () => body });
  assert.equal(good.state, 'observed');
  if (good.state === 'observed') {
    assert.equal(good.value.uid, 'rev-uid-1');
    assert.equal(JSON.stringify(good.value).includes('credential'), false);
  }
  assert.equal(
    observeCertifiedGcpCloudRunRevision('token', coordinate, {
      get: () => ({ ...body, service: 'projects/demo-project/locations/us-west1/services/other' }),
    }).state,
    'indeterminate',
  );
});

test('runtime observations reject malformed coordinates and provider failures', () => {
  let calls = 0;
  const get: GcpJsonGet = () => {
    calls++;
    return {};
  };
  assert.equal(
    observeCertifiedGcpSubscription('token', { project: '../bad', subscription: 'good' }, { get })
      .state,
    'indeterminate',
  );
  assert.equal(
    observeCertifiedGcpSchedulerJob('token', { project, location: 'bad/zone', job: 'job' }, { get })
      .state,
    'indeterminate',
  );
  assert.equal(calls, 0);
  assert.equal(
    observeCertifiedGcpSubscription(
      'token',
      { project, subscription: 'runner-jobs' },
      {
        get: () => {
          throw new Error('HTTP 403');
        },
      },
    ).state,
    'indeterminate',
  );
});
