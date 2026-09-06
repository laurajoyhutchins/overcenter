import { canonicalJson, sha256Text } from './canonical-json.js';

const SHA256 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function requireFingerprint(value) {
  const fingerprint = requiredText(value, 'obligation_fingerprint').toLowerCase();
  if (!SHA256.test(fingerprint)) throw new TypeError('obligation_fingerprint must be a sha256');
  return fingerprint;
}

function normalizeAuthority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('authority provenance is required');
  const authority = {
    kind:requiredText(value.kind, 'authority.kind'),
    repository:requiredText(value.repository, 'authority.repository'),
    revision:requiredText(value.revision, 'authority.revision').toLowerCase(),
    derivation:requiredText(value.derivation, 'authority.derivation'),
  };
  if (authority.kind === 'github' && !SHA40.test(authority.revision)) throw new TypeError('authority.revision must be an exact Git SHA');
  return Object.freeze(authority);
}

function semanticSubject(input) {
  return Object.freeze({
    project_ref:requiredText(input.project_ref, 'project_ref'),
    transition_id:requiredText(input.transition_id, 'transition_id'),
    obligation_fingerprint:requireFingerprint(input.obligation_fingerprint),
  });
}

function normalizePrerequisites(value) {
  if (!Array.isArray(value)) throw new TypeError('prerequisite_closure must be an array');
  return Object.freeze(value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('prerequisite closure entry must be an object');
    const certificateId = requiredText(entry.certificate_id, 'prerequisite_closure.certificate_id').toLowerCase();
    if (!SHA256.test(certificateId)) throw new TypeError('prerequisite certificate_id must be a sha256');
    return Object.freeze({ transition_id:requiredText(entry.transition_id, 'prerequisite_closure.transition_id'), certificate_id:certificateId });
  }).sort((a,b) => a.transition_id.localeCompare(b.transition_id) || a.certificate_id.localeCompare(b.certificate_id)));
}

function sameSubject(actual, expected) {
  return actual?.project_ref === expected.project_ref
    && actual?.transition_id === expected.transition_id
    && actual?.obligation_fingerprint === expected.obligation_fingerprint;
}

function normalizeEvidence(value, expectedSubject, field, { required = false } = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  if (required && value.length === 0) throw new TypeError('authoritative effect evidence is required');
  return Object.freeze(value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`${field} entry must be an object`);
    if (!sameSubject(entry.subject, expectedSubject)) throw new TypeError('evidence subject does not match claimed transition');
    return Object.freeze({ kind:requiredText(entry.kind, `${field}.kind`), ref:requiredText(entry.ref, `${field}.ref`), subject:expectedSubject });
  }).sort((a,b) => a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref)));
}

function identityPayload(subject) {
  return Object.freeze({
    schema:'transition-certificate-identity-v1',
    project_ref:subject.project_ref,
    transition_id:subject.transition_id,
    obligation_fingerprint:subject.obligation_fingerprint,
  });
}

function equalCanonical(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export async function createTransitionCertificate(input = {}) {
  const subject = semanticSubject(input);
  const authority = normalizeAuthority(input.authority);
  const prerequisiteClosure = normalizePrerequisites(input.prerequisite_closure || []);
  const evidenceRefs = normalizeEvidence(input.evidence_refs || [], subject, 'evidence_refs');
  const authoritativeEffectEvidence = normalizeEvidence(input.authoritative_effect_evidence || [], subject, 'authoritative_effect_evidence', { required:true });
  const claimedOutcome = requiredText(input.claimed_outcome, 'claimed_outcome');
  const identity = identityPayload(subject);
  const certificateId = await sha256Text(canonicalJson(identity));
  return Object.freeze({
    schema:'transition-certificate-v1',
    certificate_id:certificateId,
    identity,
    authority,
    prerequisite_closure:prerequisiteClosure,
    evidence_refs:evidenceRefs,
    authoritative_effect_evidence:authoritativeEffectEvidence,
    claimed_outcome:claimedOutcome,
  });
}

export function verifyTransitionCertificate(certificate, expected = {}) {
  if (!certificate || certificate.schema !== 'transition-certificate-v1') return Object.freeze({ ok:false, reason:'certificate_schema_invalid' });
  const subject = semanticSubject(expected);
  const expectedIdentity = identityPayload(subject);
  if (!equalCanonical(certificate.identity, expectedIdentity)) return Object.freeze({ ok:false, reason:'semantic_identity_mismatch' });

  const authority = normalizeAuthority(expected.authority);
  if (!equalCanonical(certificate.authority, authority)) return Object.freeze({ ok:false, reason:'authority_provenance_mismatch' });

  const prerequisiteClosure = normalizePrerequisites(expected.prerequisite_closure || []);
  if (!equalCanonical(certificate.prerequisite_closure, prerequisiteClosure)) return Object.freeze({ ok:false, reason:'prerequisite_closure_mismatch' });

  normalizeEvidence(expected.evidence_refs || [], subject, 'evidence_refs');
  normalizeEvidence(expected.authoritative_effect_evidence || [], subject, 'authoritative_effect_evidence', { required:true });
  if (certificate.claimed_outcome !== requiredText(expected.claimed_outcome, 'claimed_outcome')) return Object.freeze({ ok:false, reason:'claimed_outcome_mismatch' });

  return Object.freeze({ ok:true, certificate_id:certificate.certificate_id });
}
