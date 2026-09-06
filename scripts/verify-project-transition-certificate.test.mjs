import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProjectTransitionCertificate,
  projectTransitionCertificateFingerprint,
} from '../lib/project-transition-certificate.js';

const hex = (ch) => ch.repeat(64);
const sha = (ch) => ch.repeat(40);

const subject = Object.freeze({
  project_ref:'github:owner/repo',
  transition_id:'ship-feature',
  obligation_fingerprint:hex('a'),
});

const certificate = (overrides = {}) => ({
  schema:'project-transition-certificate-v1',
  subject,
  authority:{
    kind:'github',
    repository:'owner/repo',
    revision:sha('b'),
    derivation:'overcenter-project-graph-v1',
  },
  prerequisites:[{
    transition_id:'prepare-feature',
    obligation_fingerprint:hex('c'),
    certificate_ref:'sha256:' + hex('d'),
  }],
  authoritative_effects:[{
    kind:'github-commit',
    ref:'github:owner/repo@' + sha('e'),
    subject,
  }],
  claimed_outcome:{ disposition:'completed' },
  ...overrides,
});

test('certificate binds obligation identity, authority, predecessor closure, effects, and outcome', () => {
  assert.deepEqual(assertProjectTransitionCertificate(certificate()), certificate());
});

test('certificate representation is stable across proof ordering', async () => {
  const left = certificate({
    prerequisites:[
      { transition_id:'z', obligation_fingerprint:hex('1'), certificate_ref:'sha256:' + hex('2') },
      { transition_id:'a', obligation_fingerprint:hex('3'), certificate_ref:'sha256:' + hex('4') },
    ],
    authoritative_effects:[
      { kind:'receipt', ref:'receipt:z', subject },
      { kind:'github-commit', ref:'github:owner/repo@' + sha('e'), subject },
    ],
  });
  const right = certificate({
    prerequisites:[...left.prerequisites].reverse(),
    authoritative_effects:[...left.authoritative_effects].reverse(),
  });
  assert.equal(await projectTransitionCertificateFingerprint(left), await projectTransitionCertificateFingerprint(right));
});

test('replay of the same certificate is deterministic', async () => {
  const value = certificate();
  assert.equal(await projectTransitionCertificateFingerprint(value), await projectTransitionCertificateFingerprint(structuredClone(value)));
});

test('semantic obligation change invalidates the certificate identity', async () => {
  const baseline = await projectTransitionCertificateFingerprint(certificate());
  const changed = await projectTransitionCertificateFingerprint(certificate({
    subject:{ ...subject, obligation_fingerprint:hex('f') },
    authoritative_effects:[{
      kind:'github-commit',
      ref:'github:owner/repo@' + sha('e'),
      subject:{ ...subject, obligation_fingerprint:hex('f') },
    }],
  }));
  assert.notEqual(changed, baseline);
});

test('predecessor closure is exact and duplicate-free', () => {
  assert.throws(() => assertProjectTransitionCertificate(certificate({
    prerequisites:[
      { transition_id:'prepare-feature', obligation_fingerprint:hex('c'), certificate_ref:'sha256:' + hex('d') },
      { transition_id:'prepare-feature', obligation_fingerprint:hex('c'), certificate_ref:'sha256:' + hex('d') },
    ],
  })), (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_PREREQUISITE_CLOSURE_INVALID');
});

test('authoritative evidence bound to the wrong subject is rejected', () => {
  assert.throws(() => assertProjectTransitionCertificate(certificate({
    authoritative_effects:[{
      kind:'github-commit',
      ref:'github:owner/repo@' + sha('e'),
      subject:{ ...subject, transition_id:'different-transition' },
    }],
  })), (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_EVIDENCE_SUBJECT_MISMATCH');
});

test('volatile execution identities cannot enter certificate subject identity', () => {
  assert.throws(() => assertProjectTransitionCertificate(certificate({
    subject:{ ...subject, lease_ref:'lease-volatile' },
  })), (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_INVALID');
});
