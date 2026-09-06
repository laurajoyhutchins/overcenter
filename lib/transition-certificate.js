import { canonicalJson, sha256Text } from './canonical-json.js';

const SHA256 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;

export const PROJECT_TRANSITION_CERTIFICATE_CONTRACT = Object.freeze({
  schema:'project-transition-certificate-contract-v1',
  certificate_schema:'transition-certificate-v1',
  semantic_identity_fields:Object.freeze([
    'project_ref',
    'transition_id',
    'obligation_fingerprint',
    'prerequisite_closure.transition_id',
    'prerequisite_closure.obligation_fingerprint',
    'claimed_outcome',
  ]),
  provenance_fields:Object.freeze(['authority']),
  evidence_reference_fields:Object.freeze([
    'prerequisite_closure.certificate_id',
    'evidence_refs',
    'authoritative_effect_evidence',
  ]),
  excluded_runtime_fields:Object.freeze(['lease_ref', 'run_id', 'observed_at', 'expires_at', 'lifecycle', 'state']),
});

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function requireFingerprint(value, field = 'obligation_fingerprint') {
  const fingerprint = requiredText(value, field).toLowerCase();
  if (!SHA256.test(fingerprint)) throw new TypeError(`${field} must be a sha256`);
  return fingerprint;
}

function normalizeAuthority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('authority provenance is required');
  const authority = {
    kind:requiredText(value.kind, 'authority.kind').toLowerCase(),
    repository:requiredText(value.repository, 'authority.repository'),
    revision:requiredText(value.revision, 'authority.revision').toLowerCase(),
    derivation:requiredText(value.derivation, 'authority.derivation'),
  };
  if (authority.kind !== 'github') throw new TypeError('authority.kind must be github');
  if (!SHA40.test(authority.revision)) throw new TypeError('authority revision must be an exact Git SHA');
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
  const seen = new Set();
  const normalized = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError('prerequisite closure entry must be an object');
    const transitionId = requiredText(entry.transition_id, 'prerequisite_closure.transition_id');
    if (seen.has(transitionId)) throw new TypeError('prerequisite_closure transition ids must be unique');
    seen.add(transitionId);
    return Object.freeze({
      transition_id:transitionId,
      obligation_fingerprint:requireFingerprint(entry.obligation_fingerprint, 'prerequisite_closure.obligation_fingerprint'),
      certificate_id:requireFingerprint(entry.certificate_id, 'prerequisite_closure.certificate_id'),
    });
  }).sort((a,b) => a.transition_id.localeCompare(b.transition_id));
  return Object.freeze(normalized);
}

function prerequisiteSemantics(prerequisites) {
  return Object.freeze(prerequisites.map((entry) => Object.freeze({
    transition_id:entry.transition_id,
    obligation_fingerprint:entry.obligation_fingerprint,
  })));
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
    if (!sameSubject(entry.subject, expectedSubject)) {
      const error = new Error('evidence subject does not match claimed transition');
      error.code = 'PROJECT_TRANSITION_CERTIFICATE_EVIDENCE_SUBJECT_MISMATCH';
      throw error;
    }
    return Object.freeze({ kind:requiredText(entry.kind, `${field}.kind`), ref:requiredText(entry.ref, `${field}.ref`), subject:expectedSubject });
  }).sort((a,b) => a.kind.localeCompare(b.kind) || a.ref.localeCompare(b.ref)));
}

function identityPayload(subject, prerequisites, claimedOutcome) {
  return Object.freeze({
    schema:'transition-certificate-identity-v1',
    project_ref:subject.project_ref,
    transition_id:subject.transition_id,
    obligation_fingerprint:subject.obligation_fingerprint,
    prerequisite_semantics:prerequisiteSemantics(prerequisites),
    claimed_outcome:claimedOutcome,
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
  const identity = identityPayload(subject, prerequisiteClosure, claimedOutcome);
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

export async function verifyTransitionCertificate(certificate, expected = {}) {
  if (!certificate || certificate.schema !== 'transition-certificate-v1') return Object.freeze({ ok:false, reason:'certificate_schema_invalid' });
  const subject = semanticSubject(expected);
  const prerequisiteClosure = normalizePrerequisites(expected.prerequisite_closure || []);
  const claimedOutcome = requiredText(expected.claimed_outcome, 'claimed_outcome');
  const expectedIdentity = identityPayload(subject, prerequisiteClosure, claimedOutcome);
  if (!equalCanonical(certificate.identity, expectedIdentity)) return Object.freeze({ ok:false, reason:'semantic_identity_mismatch' });

  const expectedCertificateId = await sha256Text(canonicalJson(expectedIdentity));
  if (certificate.certificate_id !== expectedCertificateId) return Object.freeze({ ok:false, reason:'certificate_identity_digest_mismatch' });

  const authority = normalizeAuthority(expected.authority);
  if (!equalCanonical(certificate.authority, authority)) return Object.freeze({ ok:false, reason:'authority_provenance_mismatch' });
  if (!equalCanonical(certificate.prerequisite_closure, prerequisiteClosure)) return Object.freeze({ ok:false, reason:'prerequisite_closure_mismatch' });

  const expectedEvidence = normalizeEvidence(expected.evidence_refs || [], subject, 'evidence_refs');
  const expectedAuthoritative = normalizeEvidence(expected.authoritative_effect_evidence || [], subject, 'authoritative_effect_evidence', { required:true });
  let certificateEvidence;
  let certificateAuthoritative;
  try {
    certificateEvidence = normalizeEvidence(certificate.evidence_refs || [], subject, 'evidence_refs');
    certificateAuthoritative = normalizeEvidence(certificate.authoritative_effect_evidence || [], subject, 'authoritative_effect_evidence', { required:true });
  } catch (error) {
    throw error;
  }
  if (!equalCanonical(certificateEvidence, expectedEvidence)) return Object.freeze({ ok:false, reason:'evidence_reference_mismatch' });
  if (!equalCanonical(certificateAuthoritative, expectedAuthoritative)) return Object.freeze({ ok:false, reason:'authoritative_effect_evidence_mismatch' });
  if (certificate.claimed_outcome !== claimedOutcome) return Object.freeze({ ok:false, reason:'claimed_outcome_mismatch' });

  return Object.freeze({ ok:true, certificate_id:certificate.certificate_id });
}