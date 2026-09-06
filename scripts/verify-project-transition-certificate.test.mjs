import assert from 'node:assert/strict';
import test from 'node:test';
import { createTransitionCertificate, verifyTransitionCertificate } from '../lib/transition-certificate.js';

const sha = (char) => char.repeat(64);
const revision = (char) => char.repeat(40);
const projectRef = 'github:owner/repo';
const subject = Object.freeze({ project_ref:projectRef, transition_id:'B', obligation_fingerprint:sha('a') });
const evidence = (kind, ref, boundSubject = subject) => Object.freeze({ kind, ref, subject:boundSubject });

const input = (overrides = {}) => ({
  project_ref:projectRef,
  transition_id:'B',
  obligation_fingerprint:sha('a'),
  authority:{ kind:'github', repository:'owner/repo', revision:revision('b'), derivation:'overcenter-project-graph-v1' },
  prerequisite_closure:[{ transition_id:'A', obligation_fingerprint:sha('c'), certificate_id:sha('d') }],
  evidence_refs:[evidence('settlement','settlement:B:1')],
  authoritative_effect_evidence:[evidence('authoritative_effect',`github:owner/repo#42@${revision('e')}`)],
  claimed_outcome:'completed',
  ...overrides,
});

test('certificate canonicalization and replay are stable across evidence ordering', async () => {
  const first = await createTransitionCertificate(input({ evidence_refs:[evidence('verification','run:2'), evidence('settlement','settlement:B:1')] }));
  const second = await createTransitionCertificate(input({ evidence_refs:[evidence('settlement','settlement:B:1'), evidence('verification','run:2')] }));
  assert.equal(first.certificate_id, second.certificate_id);
  assert.deepEqual(verifyTransitionCertificate(first, input()), { ok:true, certificate_id:first.certificate_id });
  assert.deepEqual(verifyTransitionCertificate(first, input()), verifyTransitionCertificate(first, input()));
});

test('dependency semantic changes invalidate identity while prerequisite certificate instances do not', async () => {
  const baseline = await createTransitionCertificate(input());
  const changedDependency = await createTransitionCertificate(input({
    prerequisite_closure:[{ transition_id:'A', obligation_fingerprint:sha('f'), certificate_id:sha('d') }],
  }));
  const changedEvidenceInstance = await createTransitionCertificate(input({
    prerequisite_closure:[{ transition_id:'A', obligation_fingerprint:sha('c'), certificate_id:sha('9') }],
  }));
  assert.notEqual(changedDependency.certificate_id, baseline.certificate_id);
  assert.equal(changedEvidenceInstance.certificate_id, baseline.certificate_id);
});

test('obligation semantics change identity while runtime evidence instances do not', async () => {
  const baseline = await createTransitionCertificate(input());
  const changedObligation = await createTransitionCertificate(input({ obligation_fingerprint:sha('f') }));
  const changedEvidence = await createTransitionCertificate(input({ evidence_refs:[evidence('verification','different-run')] }));
  assert.notEqual(changedObligation.certificate_id, baseline.certificate_id);
  assert.equal(changedEvidence.certificate_id, baseline.certificate_id);
});

test('certificate binds exact authority provenance and prerequisite closure', async () => {
  const certificate = await createTransitionCertificate(input());
  assert.deepEqual(certificate.authority, input().authority);
  assert.deepEqual(certificate.prerequisite_closure, input().prerequisite_closure);
  assert.throws(() => verifyTransitionCertificate(certificate, input({ authority:{ ...input().authority, revision:revision('7') } })), /./, 'authority drift must not be accepted silently');
  assert.deepEqual(verifyTransitionCertificate(certificate, input({ authority:{ ...input().authority, revision:revision('7') } })), { ok:false, reason:'authority_provenance_mismatch' });
});

test('checker rejects evidence that is not bound to the claimed subject', async () => {
  const certificate = await createTransitionCertificate(input());
  const wrongSubject = { ...subject, transition_id:'OTHER' };
  assert.throws(
    () => verifyTransitionCertificate(certificate, input({ evidence_refs:[evidence('settlement','settlement:B:1',wrongSubject)] })),
    /evidence subject does not match claimed transition/,
  );
});

test('completion requires authoritative postcondition evidence and exact prerequisite closure', async () => {
  await assert.rejects(() => createTransitionCertificate(input({ authoritative_effect_evidence:[] })), /authoritative effect evidence is required/);
  const certificate = await createTransitionCertificate(input());
  assert.deepEqual(verifyTransitionCertificate(certificate, input({ prerequisite_closure:[] })), { ok:false, reason:'prerequisite_closure_mismatch' });
});