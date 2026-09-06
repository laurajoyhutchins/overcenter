import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransitionCertificate, verifyTransitionCertificate } from './transition-certificate.js';

const projectRef = 'github:laurajoyhutchins/overcenter';
const obligation = 'a'.repeat(64);
const authority = Object.freeze({ kind:'github', repository:'laurajoyhutchins/overcenter', revision:'1'.repeat(40), derivation:'overcenter-project-graph-v1' });
const subject = Object.freeze({ project_ref:projectRef, transition_id:'transition-a', obligation_fingerprint:obligation });
const evidence = (kind, ref, boundSubject = subject) => Object.freeze({ kind, ref, subject:boundSubject });

function input(overrides = {}) {
  return {
    project_ref:projectRef,
    transition_id:'transition-a',
    obligation_fingerprint:obligation,
    authority,
    prerequisite_closure:[{ transition_id:'prereq-a', obligation_fingerprint:'c'.repeat(64), certificate_id:'b'.repeat(64) }],
    evidence_refs:[evidence('verification','github-actions:123')],
    authoritative_effect_evidence:[evidence('github_revision','1'.repeat(40))],
    claimed_outcome:'completed',
    ...overrides,
  };
}

test('transition certificate canonicalization is replay-stable and ignores unrelated evidence ordering', async () => {
  const first = await createTransitionCertificate(input({ evidence_refs:[evidence('receipt','receipt:2'), evidence('verification','github-actions:123')] }));
  const second = await createTransitionCertificate(input({ evidence_refs:[evidence('verification','github-actions:123'), evidence('receipt','receipt:2')] }));
  assert.equal(first.certificate_id, second.certificate_id);
  assert.deepEqual(await verifyTransitionCertificate(first, { ...input(), evidence_refs:first.evidence_refs }), { ok:true, certificate_id:first.certificate_id });
});

test('semantic obligation and dependency changes invalidate identity while provenance/evidence instances do not define it', async () => {
  const original = await createTransitionCertificate(input());
  const semanticChange = await createTransitionCertificate(input({ obligation_fingerprint:'d'.repeat(64) }));
  const dependencyChange = await createTransitionCertificate(input({ prerequisite_closure:[{ transition_id:'prereq-a', obligation_fingerprint:'e'.repeat(64), certificate_id:'b'.repeat(64) }] }));
  const evidenceChange = await createTransitionCertificate(input({ evidence_refs:[evidence('verification','github-actions:999')] }));
  const prerequisiteInstanceChange = await createTransitionCertificate(input({ prerequisite_closure:[{ transition_id:'prereq-a', obligation_fingerprint:'c'.repeat(64), certificate_id:'f'.repeat(64) }] }));
  assert.notEqual(original.certificate_id, semanticChange.certificate_id);
  assert.notEqual(original.certificate_id, dependencyChange.certificate_id);
  assert.equal(original.certificate_id, evidenceChange.certificate_id);
  assert.equal(original.certificate_id, prerequisiteInstanceChange.certificate_id);
});

test('checker rejects incomplete prerequisite closure and evidence bound to another semantic subject', async () => {
  const certificate = await createTransitionCertificate(input());
  const missingPrerequisite = await verifyTransitionCertificate(certificate, input({ prerequisite_closure:[] }));
  assert.equal(missingPrerequisite.ok, false);

  const wrongSubject = { ...subject, transition_id:'transition-b' };
  await assert.rejects(
    () => verifyTransitionCertificate(certificate, input({ evidence_refs:[evidence('verification','github-actions:123', wrongSubject)] })),
    /evidence subject does not match claimed transition/,
  );
});

test('checker rejects authority provenance drift and missing authoritative postcondition evidence', async () => {
  const certificate = await createTransitionCertificate(input());
  const drifted = await verifyTransitionCertificate(certificate, input({ authority:{ ...authority, revision:'2'.repeat(40) } }));
  assert.equal(drifted.ok, false);
  assert.equal(drifted.reason, 'authority_provenance_mismatch');
  await assert.rejects(() => createTransitionCertificate(input({ authoritative_effect_evidence:[] })), /authoritative effect evidence is required/);
});