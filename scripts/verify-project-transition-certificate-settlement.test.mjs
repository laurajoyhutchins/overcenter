import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProjectTransitionSettlementCertificate,
  projectTransitionObligationFingerprint,
  replayProjectTransitionSettlementCertificate,
} from '../lib/project-transition-certificate-settlement.js';

const sha = (ch) => ch.repeat(40);
const project_ref = 'github:owner/repo';
const authority = Object.freeze({ kind:'github', repository:'owner/repo', revision:sha('a'), derivation:'overcenter-project-graph-v1' });
function transition(overrides = {}) {
  return {
    id:'ship-feature', priority:10, requires:[], executor:{ kind:'agent', role:'implementation' }, phase_bindings:{},
    execution_intent:{ schema:'project-execution-intent-v1', desired_outcome:'Ship verified work.', acceptance_evidence:[{ kind:'tests', requirement:'Focused tests pass.' }] },
    ...overrides,
  };
}

test('valid certificate replays deterministically', async () => {
  const current = transition();
  const certificate = await createProjectTransitionSettlementCertificate({ project_ref, transition:current, authority, evidence:[{ kind:'tests', ref:'run:10' }] });
  const first = await replayProjectTransitionSettlementCertificate({ project_ref, transition:current, authority, certificate });
  const second = await replayProjectTransitionSettlementCertificate({ project_ref, transition:current, authority, certificate:structuredClone(certificate) });
  assert.equal(first.certificate_ref, second.certificate_ref);
  assert.equal(first.obligation_fingerprint, await projectTransitionObligationFingerprint(current));
});

test('changed obligation semantics invalidate an existing certificate', async () => {
  const original = transition();
  const certificate = await createProjectTransitionSettlementCertificate({ project_ref, transition:original, authority, evidence:[{ kind:'tests', ref:'run:10' }] });
  const changed = transition({ execution_intent:{ ...original.execution_intent, desired_outcome:'Ship stronger verified work.' } });
  await assert.rejects(replayProjectTransitionSettlementCertificate({ project_ref, transition:changed, authority, certificate }), (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_OBLIGATION_STALE');
});

test('declared acceptance evidence is mandatory', async () => {
  await assert.rejects(createProjectTransitionSettlementCertificate({ project_ref, transition:transition(), authority, evidence:[] }), (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_EVIDENCE_INCOMPLETE');
});

test('predecessor closure must be exact and certificate-addressed', async () => {
  const predecessorTransition = transition({ id:'prepare-feature' });
  const predecessor = await createProjectTransitionSettlementCertificate({ project_ref, transition:predecessorTransition, authority, evidence:[{ kind:'tests', ref:'run:prepare' }] });
  const current = transition({ requires:['prepare-feature'] });
  const certificate = await createProjectTransitionSettlementCertificate({ project_ref, transition:current, authority, evidence:[{ kind:'tests', ref:'run:ship' }], predecessor_certificates:[predecessor], predecessor_transitions:[predecessorTransition] });
  const result = await replayProjectTransitionSettlementCertificate({ project_ref, transition:current, authority, certificate, predecessor_certificates:[predecessor], predecessor_transitions:[predecessorTransition] });
  assert.equal(result.certificate.prerequisites.length, 1);
  assert.match(result.certificate.prerequisites[0].certificate_ref, /^sha256:[0-9a-f]{64}$/);
  await assert.rejects(replayProjectTransitionSettlementCertificate({ project_ref, transition:current, authority, certificate, predecessor_certificates:[], predecessor_transitions:[] }), (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_PREREQUISITE_CLOSURE_INVALID');
});
