import assert from 'node:assert/strict';
import test from 'node:test';

const sha = (char) => char.repeat(64);
const revision = (char) => char.repeat(40);

async function certificateModule() {
  return import('../lib/project-transition-certificate.js');
}

const input = (overrides = {}) => ({
  project_ref:'github:owner/repo',
  transition_id:'B',
  obligation_fingerprint:sha('a'),
  authority:{ kind:'github', repository:'owner/repo', revision:revision('b'), derivation:'overcenter-project-graph-v1' },
  prerequisite_closure:[{ transition_id:'A', obligation_fingerprint:sha('c') }],
  evidence:[
    { kind:'settlement', ref:'settlement:B:1', subject:{ project_ref:'github:owner/repo', transition_id:'B', obligation_fingerprint:sha('a') } },
    { kind:'authoritative_effect', ref:`github:owner/repo#42@${revision('d')}`, subject:{ project_ref:'github:owner/repo', transition_id:'B', obligation_fingerprint:sha('a') } },
  ],
  outcome:'completed',
  ...overrides,
});

test('transition certificate contract is available as one canonical module', async () => {
  const mod = await certificateModule();
  assert.equal(typeof mod.createProjectTransitionCertificate, 'function');
  assert.equal(typeof mod.verifyProjectTransitionCertificate, 'function');
});

test('certificate canonicalization is stable across evidence ordering and replay', async () => {
  const { createProjectTransitionCertificate, verifyProjectTransitionCertificate } = await certificateModule();
  const left = await createProjectTransitionCertificate(input());
  const right = await createProjectTransitionCertificate(input({ evidence:[...input().evidence].reverse() }));
  assert.equal(left.certificate_id, right.certificate_id);
  assert.deepEqual(verifyProjectTransitionCertificate(left), { accepted:true, certificate:left });
  assert.deepEqual(verifyProjectTransitionCertificate(left), verifyProjectTransitionCertificate(left));
});

test('semantic identity changes when obligation or dependency semantics change, not evidence instances', async () => {
  const { createProjectTransitionCertificate } = await certificateModule();
  const baseline = await createProjectTransitionCertificate(input());
  const changedObligation = await createProjectTransitionCertificate(input({ obligation_fingerprint:sha('e') }));
  const changedDependency = await createProjectTransitionCertificate(input({ prerequisite_closure:[{ transition_id:'A', obligation_fingerprint:sha('f') }] }));
  const changedEvidenceInstance = await createProjectTransitionCertificate(input({ evidence:input().evidence.map((entry, index) => ({ ...entry, ref:`replacement:${index}` })) }));
  assert.notEqual(changedObligation.certificate_id, baseline.certificate_id);
  assert.notEqual(changedDependency.certificate_id, baseline.certificate_id);
  assert.equal(changedEvidenceInstance.certificate_id, baseline.certificate_id);
});

test('certificate retains exact authority provenance and predecessor closure', async () => {
  const { createProjectTransitionCertificate } = await certificateModule();
  const certificate = await createProjectTransitionCertificate(input());
  assert.deepEqual(certificate.authority, input().authority);
  assert.deepEqual(certificate.prerequisite_closure, input().prerequisite_closure);
  assert.throws(() => createProjectTransitionCertificate(input({ authority:{ ...input().authority, revision:'moving-branch' } })), /authority revision/i);
});

test('verification rejects evidence not bound to the claimed transition subject', async () => {
  const { createProjectTransitionCertificate, verifyProjectTransitionCertificate } = await certificateModule();
  const certificate = await createProjectTransitionCertificate(input());
  const forged = structuredClone(certificate);
  forged.evidence[0].subject.transition_id = 'OTHER';
  assert.throws(() => verifyProjectTransitionCertificate(forged), (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_EVIDENCE_SUBJECT_MISMATCH');
});

test('completion requires authoritative postcondition evidence and prerequisite closure', async () => {
  const { createProjectTransitionCertificate } = await certificateModule();
  await assert.rejects(() => createProjectTransitionCertificate(input({ evidence:input().evidence.filter((entry) => entry.kind !== 'authoritative_effect') })), (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_AUTHORITATIVE_EFFECT_REQUIRED');
  await assert.rejects(() => createProjectTransitionCertificate(input({ prerequisite_closure:[] })), (error) => error?.code === 'PROJECT_TRANSITION_CERTIFICATE_PREREQUISITE_CLOSURE_REQUIRED');
});