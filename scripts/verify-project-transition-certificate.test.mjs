import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROJECT_TRANSITION_CERTIFICATE_CONTRACT,
  createTransitionCertificate,
  verifyTransitionCertificate,
} from '../lib/transition-certificate.js';

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

test('certificate contract explicitly separates semantic identity, provenance, and evidence references', () => {
  assert.equal(PROJECT_TRANSITION_CERTIFICATE_CONTRACT.schema, 'project-transition-certificate-contract-v1');
  assert.ok(PROJECT_TRANSITION_CERTIFICATE_CONTRACT.semantic_identity_fields.includes('prerequisite_closure.obligation_fingerprint'));
  assert.ok(PROJECT_TRANSITION_CERTIFICATE_CONTRACT.provenance_fields.includes('authority'));
  assert.ok(PROJECT_TRANSITION_CERTIFICATE_CONTRACT.evidence_reference_fields.includes('authoritative_effect_evidence'));
  assert.ok(PROJECT_TRANSITION_CERTIFICATE_CONTRACT.excluded_runtime_fields.includes('lease_ref'));
});

test('certificate canonicalization and replay are stable across evidence ordering', async () => {
  const first = await createTransitionCertificate(input({ evidence_refs:[evidence('verification','run:2'), evidence('settlement','settlement:B:1')] }));
  const second = await createTransitionCertificate(input({ evidence_refs:[evidence('settlement','settlement:B:1'), evidence('verification','run:2')] }));
  assert.equal(first.certificate_id, second.certificate_id);
  assert.deepEqual(await verifyTransitionCertificate(first, { ...input(), evidence_refs:first.evidence_refs }), { ok:true, certificate_id:first.certificate_id });
  assert.deepEqual(await verifyTransitionCertificate(first, { ...input(), evidence_refs:first.evidence_refs }), await verifyTransitionCertificate(first, { ...input(), evidence_refs:first.evidence_refs }));
});

test('dependency semantic changes invalidate identity while prerequisite certificate instances do not', async () => {
  const baseline = await createTransitionCertificate(input());
  const changedDependency = await createTransitionCertificate(input({ prerequisite_closure:[{ transition_id:'A', obligation_fingerprint:sha('f'), certificate_id:sha('d') }] }));
  const changedEvidenceInstance = await createTransitionCertificate(input({ prerequisite_closure:[{ transition_id:'A', obligation_fingerprint:sha('c'), certificate_id:sha('9') }] }));
  assert.notEqual(changedDependency.certificate_id, baseline.certificate_id);
  assert.equal(changedEvidenceInstance.certificate_id, baseline.certificate_id);
});

test('obligation semantics change identity while runtime evidence instances do not', async () => {
  const baseline = await createTransitionCertificate(input());
  const changedSubject = { ...subject, obligation_fingerprint:sha('f') };
  const changedObligation = await createTransitionCertificate(input({
    obligation_fingerprint:sha('f'),
    evidence_refs:[evidence('settlement','settlement:B:1',changedSubject)],
    authoritative_effect_evidence:[evidence('authoritative_effect',`github:owner/repo#42@${revision('e')}`,changedSubject)],
  }));
  const changedEvidence = await createTransitionCertificate(input({ evidence_refs:[evidence('verification','different-run')] }));
  assert.notEqual(changedObligation.certificate_id, baseline.certificate_id);
  assert.equal(changedEvidence.certificate_id, baseline.certificate_id);
});

test('certificate binds exact authority provenance and prerequisite closure', async () => {
  const certificate = await createTransitionCertificate(input());
  assert.deepEqual(certificate.authority, input().authority);
  assert.deepEqual(certificate.prerequisite_closure, input().prerequisite_closure);
  assert.deepEqual(await verifyTransitionCertificate(certificate, input({ authority:{ ...input().authority, revision:revision('7') } })), { ok:false, reason:'authority_provenance_mismatch' });
  assert.deepEqual(await verifyTransitionCertificate(certificate, input({ prerequisite_closure:[] })), { ok:false, reason:'semantic_identity_mismatch' });
});

test('checker rejects evidence not bound to the claimed subject and a forged certificate id', async () => {
  const certificate = await createTransitionCertificate(input());
  const wrongSubject = { ...subject, transition_id:'OTHER' };
  await assert.rejects(
    () => verifyTransitionCertificate(certificate, input({ evidence_refs:[evidence('settlement','settlement:B:1',wrongSubject)] })),
    (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_EVIDENCE_SUBJECT_MISMATCH',
  );
  assert.deepEqual(await verifyTransitionCertificate({ ...certificate, certificate_id:sha('0') }, input()), { ok:false, reason:'certificate_identity_digest_mismatch' });
});

test('completion requires authoritative postcondition evidence', async () => {
  await assert.rejects(() => createTransitionCertificate(input({ authoritative_effect_evidence:[] })), /authoritative effect evidence is required/);
});