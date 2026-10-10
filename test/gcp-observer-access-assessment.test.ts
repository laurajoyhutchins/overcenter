import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessGcpObserverAccess,
  GCP_OBSERVER_ACCESS_PROBES,
  GCP_OBSERVER_TROUBLESHOOTER_ENDPOINT,
} from '../src/providers/gcp/observer-access-assessment.ts';

function observed(
  changes: Record<string, string> = {},
): Array<{ id: string; evidence_ref: string; response: unknown }> {
  return GCP_OBSERVER_ACCESS_PROBES.map((probe) => ({
    id: probe.id,
    evidence_ref: 'receipt:sha256:abc123',
    response: {
      accessTuple: { ...probe.accessTuple },
      overallAccessState: changes[probe.id] ?? probe.expected_state,
    },
  }));
}

test('only fixed observer resource and permission tuples can be planned', () => {
  assert.equal(GCP_OBSERVER_ACCESS_PROBES.length, 4);
  assert.equal(
    GCP_OBSERVER_ACCESS_PROBES.find((probe) => probe.id === 'mig-resize-denied')?.accessTuple
      .permission,
    'compute.instanceGroupManagers.update',
  );
  assert.equal(GCP_OBSERVER_TROUBLESHOOTER_ENDPOINT.method, 'POST');
  assert.equal(GCP_OBSERVER_TROUBLESHOOTER_ENDPOINT.path, '/v3beta/iam:troubleshoot');
  assert.equal(GCP_OBSERVER_TROUBLESHOOTER_ENDPOINT.mutation_authorized, false);
  assert.equal(Object.isFrozen(GCP_OBSERVER_ACCESS_PROBES), true);
  for (const probe of GCP_OBSERVER_ACCESS_PROBES) {
    assert.equal(Object.isFrozen(probe), true);
    assert.equal(Object.isFrozen(probe.accessTuple), true);
    assert.match(probe.accessTuple.principal, /^overcenter-observer@/);
    assert.match(probe.accessTuple.fullResourceName, /^\/\/compute\.googleapis\.com\//);
  }
});

test('matching sample cannot authorize mutations, prove ceiling or prove live readback', () => {
  const result = assessGcpObserverAccess(observed());
  assert.equal(result.state, 'sample_matches');
  assert.deepEqual(result.findings, []);
  assert.equal(result.authorization_granted, false);
  assert.equal(result.full_permission_ceiling_verified, false);
  assert.equal(result.live_resource_readback_established, false);
});

test('unexpected read grants or missing authorized reads require review', () => {
  const result = assessGcpObserverAccess(
    observed({ 'mig-read': 'CANNOT_ACCESS', 'autoscaler-update-denied': 'CAN_ACCESS' }),
  );
  assert.equal(result.state, 'review_required');
  assert.equal(result.findings.length, 2);
  assert.equal(result.authorization_granted, false);
});

test('unknown, denied, missing and forged information holds rather than proving absence', () => {
  for (const value of ['UNKNOWN_INFO', 'UNKNOWN_CONDITIONAL', 'OVERALL_ACCESS_STATE_UNSPECIFIED']) {
    assert.equal(assessGcpObserverAccess(observed({ 'mig-read': value })).state, 'hold');
  }
  assert.equal(assessGcpObserverAccess(observed().slice(1)).state, 'hold');
  const wrongPrincipal = observed();
  const record = wrongPrincipal[0];
  assert.ok(record && typeof record.response === 'object');
  record.response = {
    accessTuple: {
      ...GCP_OBSERVER_ACCESS_PROBES[0]?.accessTuple,
      principal: 'attacker@example.com',
    },
    overallAccessState: 'CAN_ACCESS',
  };
  assert.equal(assessGcpObserverAccess(wrongPrincipal).state, 'hold');
});

test('replayed, extra, malformed or unreceipted evidence holds', () => {
  const responses = observed();
  assert.equal(assessGcpObserverAccess([...responses, responses[0]!]).state, 'hold');
  assert.equal(
    assessGcpObserverAccess([
      ...responses,
      { id: 'arbitrary-grant', evidence_ref: 'r', response: {} },
    ]).state,
    'hold',
  );
  assert.equal(
    assessGcpObserverAccess(
      responses.map((value, index) => (index === 0 ? { ...value, evidence_ref: '' } : value)),
    ).state,
    'hold',
  );
  assert.equal(
    assessGcpObserverAccess(
      responses.map((value, index) => (index === 0 ? { ...value, response: null } : value)),
    ).state,
    'hold',
  );
});
