import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OWNER_CONSENT_SCHEMA,
  ownerConsentRequestDigest,
  ownerConsentSummary,
  routeOwnerConsent,
  type ObservedConsentImpact,
  type OwnerConsentRequest,
} from '../src/owner-consent.ts';

const sha = (c: string) => c.repeat(40);
const ordinary: ObservedConsentImpact = {
  evidence: 'independently-verified',
  effects: [],
  changed_paths: ['src/cli/example.ts'],
  protected_paths: ['.github', 'architecture', 'src/source'],
};
const request: OwnerConsentRequest = {
  schema: OWNER_CONSENT_SCHEMA,
  request_id: 'operation-42',
  repository: 'laurajoyhutchins/overcenter',
  base_sha: sha('a'),
  candidate_sha: sha('b'),
  candidate_tree_sha: sha('c'),
  expires_at: '2026-10-12T12:00:00.000Z',
  operation: 'production-cutover',
  outcome: 'Move the production service to a new deployment',
  why: 'The current deployment has a verified reliability problem',
  scope: 'One named Cloud Run service in one GCP project',
  risks: 'Temporary downtime and additional measured cost',
  approval_consequence: 'Authorize only this exact candidate to be independently admitted',
  rejection_consequence: 'No production mutation; existing deployment remains',
  recovery: 'Restore the last independently observed working revision',
  verification: 'Compare expected resource identity and postcondition after execution',
  evidence_url: 'https://github.com/laurajoyhutchins/overcenter/issues/702',
};

test('ordinary observed source maintenance is only a non-authorizing candidate', () => {
  assert.equal(routeOwnerConsent(ordinary).kind, 'routine-candidate');
});

test('every consequential effect goes to owner review', () => {
  for (const effect of [
    'privilege-grant',
    'protection-policy-change',
    'production-cutover',
    'irreversible-data-change',
    'material-financial-commitment',
    'external-legal-commitment',
  ] as const) {
    assert.equal(routeOwnerConsent({ ...ordinary, effects: [effect] }).kind, 'owner-review');
  }
});

test('unknown, invalid and duplicate evidence never requests approval', () => {
  assert.equal(routeOwnerConsent({ ...ordinary, evidence: 'unknown' }).kind, 'hold');
  assert.equal(routeOwnerConsent({ ...ordinary, effects: ['unknown' as never] }).kind, 'hold');
  assert.equal(
    routeOwnerConsent({ ...ordinary, effects: ['privilege-grant', 'privilege-grant'] }).kind,
    'hold',
  );
  assert.equal(routeOwnerConsent({ ...ordinary, changed_paths: [] }).kind, 'hold');
  assert.equal(routeOwnerConsent({ ...ordinary, changed_paths: ['../secrets'] }).kind, 'hold');
  assert.equal(routeOwnerConsent({ ...ordinary, changed_paths: ['b', 'a'] }).kind, 'hold');
});

test('protected source maintenance is held without independently admitted exact path delegation', () => {
  const protectedChange = { ...ordinary, changed_paths: ['architecture/physics.sql'] };
  assert.equal(routeOwnerConsent(protectedChange).kind, 'hold');
  assert.equal(
    routeOwnerConsent({
      ...protectedChange,
      routine_policy: {
        id: 'routine-architecture-reconciliation/v1',
        permitted_paths: ['architecture/physics.sql'],
        independently_admitted: false,
      },
    }).kind,
    'hold',
  );
  assert.equal(
    routeOwnerConsent({
      ...protectedChange,
      routine_policy: {
        id: 'routine-architecture-reconciliation/v1',
        permitted_paths: ['architecture/physics.sql'],
        independently_admitted: true,
      },
    }).kind,
    'routine-candidate',
  );
  assert.equal(
    routeOwnerConsent({
      ...protectedChange,
      routine_policy: {
        id: 'routine-architecture-reconciliation/v1',
        permitted_paths: ['architecture/other.sql'],
        independently_admitted: true,
      },
    }).kind,
    'hold',
  );
});

test('plain-language consent explanation includes both consequences and exact identity', () => {
  const summary = ownerConsentSummary(request);
  for (const snippet of [
    request.outcome,
    request.why,
    request.scope,
    request.risks,
    request.approval_consequence,
    request.rejection_consequence,
    request.recovery,
    request.verification,
    request.candidate_sha,
    request.evidence_url,
    request.expires_at,
  ])
    assert.ok(summary.includes(snippet));
  assert.match(summary, /Request digest: [0-9a-f]{64}/);
});

test('changing any consequential part invalidates the exact request digest', () => {
  const previous = ownerConsentRequestDigest(request);
  for (const mutation of [
    { scope: 'A different cloud resource' },
    { candidate_sha: sha('d') },
    { operation: 'privilege-grant' as const },
    { risks: 'New risk' },
    { rejection_consequence: 'A new rejection effect' },
  ])
    assert.notEqual(ownerConsentRequestDigest({ ...request, ...mutation }), previous);
});

test('refuse incomplete consent, forged fields, free-form effects and invalid revisions', () => {
  for (const malformed of [
    { ...request, outcome: '' },
    { ...request, risks: '\nmisleading second line' },
    { ...request, base_sha: 'main' },
    { ...request, operation: 'routine-maintenance' },
    { ...request, evidence_url: 'https://example.com/untrusted' },
    { ...request, expires_at: 'not a date' },
    { ...request, injected_operation: 'delete-everything' },
  ])
    assert.throws(() => ownerConsentRequestDigest(malformed), /OWNER_CONSENT_REQUEST_INVALID/);
});
