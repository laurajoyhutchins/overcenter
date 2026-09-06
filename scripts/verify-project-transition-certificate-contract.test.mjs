import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTransitionCertificate,
  computeTransitionObligationFingerprint,
  verifyTransitionCertificate,
} from '../lib/project-transition-certificate.js';

const projectRef = 'github:laurajoyhutchins/overcenter';
const authority = Object.freeze({
  kind: 'github',
  repository: 'laurajoyhutchins/overcenter',
  revision: '1111111111111111111111111111111111111111',
  derivation: 'overcenter-project-graph-v1',
});

function transition(overrides = {}) {
  return {
    transition_id: 'ship-widget',
    kind: 'integration',
    title: 'Ship widget',
    execution_intent: {
      schema: 'project-execution-intent-v1',
      desired_outcome: 'Widget is integrated at the exact verified revision.',
      acceptance_evidence: [
        { kind: 'verification', requirement: 'Exact-revision verification passes.' },
        { kind: 'readback', requirement: 'GitHub authority contains the candidate.' },
      ],
    },
    acceptance_evidence: [],
    dependencies: ['build-widget', 'verify-widget'],
    executor: { type: 'agent', role: 'implementation', skill: 'test-driven-development' },
    state: 'ready',
    source_refs: ['github:issue:1'],
    ...overrides,
  };
}

function evidence(kind, ref, obligationFingerprint, transitionId = 'ship-widget') {
  return {
    kind,
    ref,
    subject: {
      project_ref: projectRef,
      transition_id: transitionId,
      obligation_fingerprint: obligationFingerprint,
    },
  };
}

test('transition obligation fingerprint is canonical and representation-stable', async () => {
  const original = transition();
  const reordered = transition({
    title: 'Renamed display title',
    state: 'working',
    source_refs: ['github:issue:999'],
    dependencies: ['verify-widget', 'build-widget'],
    execution_intent: {
      ...original.execution_intent,
      acceptance_evidence: [...original.execution_intent.acceptance_evidence].reverse(),
    },
  });
  assert.equal(
    await computeTransitionObligationFingerprint(original),
    await computeTransitionObligationFingerprint(reordered),
  );
});

test('semantic obligation changes invalidate the fingerprint', async () => {
  const original = transition();
  const changedOutcome = transition({
    execution_intent: { ...original.execution_intent, desired_outcome: 'Different outcome.' },
  });
  const changedAcceptance = transition({
    execution_intent: {
      ...original.execution_intent,
      acceptance_evidence: [{ kind: 'verification', requirement: 'A stronger check passes.' }],
    },
  });
  const changedDependencies = transition({ dependencies: ['build-widget'] });

  const fingerprint = await computeTransitionObligationFingerprint(original);
  assert.notEqual(fingerprint, await computeTransitionObligationFingerprint(changedOutcome));
  assert.notEqual(fingerprint, await computeTransitionObligationFingerprint(changedAcceptance));
  assert.notEqual(fingerprint, await computeTransitionObligationFingerprint(changedDependencies));
});

test('certificate replay is deterministic and evidence instances are not semantic identity', async () => {
  const obligationFingerprint = await computeTransitionObligationFingerprint(transition());
  const input = {
    project_ref: projectRef,
    transition: transition(),
    authority,
    prerequisite_evidence: [
      evidence('transition-certificate', 'certificate:build-widget', obligationFingerprint),
      evidence('transition-certificate', 'certificate:verify-widget', obligationFingerprint),
    ],
    authoritative_effect_evidence: [evidence('github-readback', 'github:commit:abc', obligationFingerprint)],
    settlement_evidence: [evidence('settlement', 'settlement:1', obligationFingerprint)],
    execution_evidence: [evidence('execution', 'execution:1', obligationFingerprint)],
    claimed_outcome: 'completed',
  };
  const first = await buildTransitionCertificate(input);
  const second = await buildTransitionCertificate({
    ...input,
    settlement_evidence: [evidence('settlement', 'settlement:other', obligationFingerprint)],
    execution_evidence: [evidence('execution', 'execution:other', obligationFingerprint)],
  });

  assert.equal(first.semantic_identity, second.semantic_identity);
  assert.deepEqual(await verifyTransitionCertificate(first, transition(), authority), { accepted: true, reasons: [] });
  assert.deepEqual(await verifyTransitionCertificate(first, transition(), authority), { accepted: true, reasons: [] });
});

test('certificate requires prerequisite closure and subject-bound evidence', async () => {
  const obligationFingerprint = await computeTransitionObligationFingerprint(transition());
  const certificate = await buildTransitionCertificate({
    project_ref: projectRef,
    transition: transition(),
    authority,
    prerequisite_evidence: [evidence('transition-certificate', 'certificate:build-widget', obligationFingerprint)],
    authoritative_effect_evidence: [evidence('github-readback', 'github:commit:abc', obligationFingerprint, 'other-transition')],
    settlement_evidence: [evidence('settlement', 'settlement:1', obligationFingerprint)],
    execution_evidence: [evidence('execution', 'execution:1', obligationFingerprint)],
    claimed_outcome: 'completed',
  });
  const result = await verifyTransitionCertificate(certificate, transition(), authority);
  assert.equal(result.accepted, false);
  assert.ok(result.reasons.includes('PREREQUISITE_CLOSURE_INCOMPLETE'));
  assert.ok(result.reasons.includes('EVIDENCE_SUBJECT_MISMATCH'));
});