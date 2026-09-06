import { canonicalJson, sha256Text } from './canonical-json.js';
import { assertExactObligationAuthorityCoordinate } from './project-obligation-contract.js';

export const PROJECT_TRANSITION_CERTIFICATE_SCHEMA = 'project-transition-certificate-v1';

const HEX64 = /^[0-9a-f]{64}$/;
const PROJECT_REF = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/;

function fail(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function record(value, field, code = 'PROJECT_TRANSITION_CERTIFICATE_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code, `${field} must be an object`, { field });
  return value;
}

function exactKeys(value, allowed, field, code = 'PROJECT_TRANSITION_CERTIFICATE_INVALID') {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) fail(code, `${field} contains unsupported fields`, { field, unsupported_fields:unknown });
}

function text(value, field, code = 'PROJECT_TRANSITION_CERTIFICATE_INVALID') {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) fail(code, `${field} must be a non-empty string`, { field });
  return normalized;
}

function fingerprint(value, field) {
  const normalized = text(value, field).toLowerCase();
  if (!HEX64.test(normalized)) fail('PROJECT_TRANSITION_CERTIFICATE_INVALID', `${field} must be a sha256 fingerprint`, { field });
  return normalized;
}

function normalizeSubject(raw, field = 'subject') {
  const input = record(raw, field);
  exactKeys(input, new Set(['project_ref', 'transition_id', 'obligation_fingerprint']), field);
  const projectRef = text(input.project_ref, `${field}.project_ref`);
  if (!PROJECT_REF.test(projectRef)) fail('PROJECT_TRANSITION_CERTIFICATE_INVALID', `${field}.project_ref must be github:owner/repo`, { field:`${field}.project_ref` });
  return Object.freeze({
    project_ref:projectRef,
    transition_id:text(input.transition_id, `${field}.transition_id`),
    obligation_fingerprint:fingerprint(input.obligation_fingerprint, `${field}.obligation_fingerprint`),
  });
}

function sameSubject(left, right) {
  return left.project_ref === right.project_ref
    && left.transition_id === right.transition_id
    && left.obligation_fingerprint === right.obligation_fingerprint;
}

function normalizePrerequisites(raw, subject) {
  if (!Array.isArray(raw)) fail('PROJECT_TRANSITION_CERTIFICATE_PREREQUISITE_CLOSURE_INVALID', 'prerequisites must be an array');
  const seen = new Set();
  const normalized = raw.map((value, index) => {
    const item = record(value, `prerequisites[${index}]`, 'PROJECT_TRANSITION_CERTIFICATE_PREREQUISITE_CLOSURE_INVALID');
    exactKeys(item, new Set(['transition_id', 'obligation_fingerprint', 'certificate_ref']), `prerequisites[${index}]`, 'PROJECT_TRANSITION_CERTIFICATE_PREREQUISITE_CLOSURE_INVALID');
    const transitionId = text(item.transition_id, `prerequisites[${index}].transition_id`, 'PROJECT_TRANSITION_CERTIFICATE_PREREQUISITE_CLOSURE_INVALID');
    if (transitionId === subject.transition_id || seen.has(transitionId)) {
      fail('PROJECT_TRANSITION_CERTIFICATE_PREREQUISITE_CLOSURE_INVALID', 'prerequisite closure must contain each predecessor exactly once', { transition_id:transitionId });
    }
    seen.add(transitionId);
    return Object.freeze({
      transition_id:transitionId,
      obligation_fingerprint:fingerprint(item.obligation_fingerprint, `prerequisites[${index}].obligation_fingerprint`),
      certificate_ref:text(item.certificate_ref, `prerequisites[${index}].certificate_ref`, 'PROJECT_TRANSITION_CERTIFICATE_PREREQUISITE_CLOSURE_INVALID'),
    });
  });
  normalized.sort((left, right) => left.transition_id.localeCompare(right.transition_id)
    || left.obligation_fingerprint.localeCompare(right.obligation_fingerprint)
    || left.certificate_ref.localeCompare(right.certificate_ref));
  return Object.freeze(normalized);
}

function normalizeEffects(raw, subject) {
  if (!Array.isArray(raw) || raw.length === 0) fail('PROJECT_TRANSITION_CERTIFICATE_INVALID', 'authoritative_effects must be a non-empty array');
  const normalized = raw.map((value, index) => {
    const item = record(value, `authoritative_effects[${index}]`);
    exactKeys(item, new Set(['kind', 'ref', 'subject']), `authoritative_effects[${index}]`);
    const evidenceSubject = normalizeSubject(item.subject, `authoritative_effects[${index}].subject`);
    if (!sameSubject(evidenceSubject, subject)) {
      fail('PROJECT_TRANSITION_CERTIFICATE_EVIDENCE_SUBJECT_MISMATCH', 'authoritative evidence is bound to a different transition obligation', {
        expected_subject:subject,
        observed_subject:evidenceSubject,
      });
    }
    return Object.freeze({
      kind:text(item.kind, `authoritative_effects[${index}].kind`),
      ref:text(item.ref, `authoritative_effects[${index}].ref`),
      subject:evidenceSubject,
    });
  });
  normalized.sort((left, right) => left.kind.localeCompare(right.kind) || left.ref.localeCompare(right.ref));
  return Object.freeze(normalized);
}

function normalizeOutcome(raw) {
  const input = record(raw, 'claimed_outcome');
  exactKeys(input, new Set(['disposition']), 'claimed_outcome');
  const disposition = text(input.disposition, 'claimed_outcome.disposition');
  if (disposition !== 'completed') fail('PROJECT_TRANSITION_CERTIFICATE_INVALID', 'a satisfied transition certificate must claim completed disposition', { disposition });
  return Object.freeze({ disposition });
}

export function assertProjectTransitionCertificate(raw) {
  const input = record(raw, 'certificate');
  exactKeys(input, new Set(['schema', 'subject', 'authority', 'prerequisites', 'authoritative_effects', 'claimed_outcome']), 'certificate');
  if (input.schema !== PROJECT_TRANSITION_CERTIFICATE_SCHEMA) fail('PROJECT_TRANSITION_CERTIFICATE_INVALID', 'certificate schema is not supported', { schema:input.schema ?? null });
  const subject = normalizeSubject(input.subject);
  const authority = assertExactObligationAuthorityCoordinate(input.authority);
  const match = PROJECT_REF.exec(subject.project_ref);
  if (!match || match[1].toLowerCase() !== authority.repository.toLowerCase()) {
    fail('PROJECT_TRANSITION_CERTIFICATE_INVALID', 'certificate subject project and authority repository must match', { project_ref:subject.project_ref, repository:authority.repository });
  }
  return Object.freeze({
    schema:PROJECT_TRANSITION_CERTIFICATE_SCHEMA,
    subject,
    authority,
    prerequisites:normalizePrerequisites(input.prerequisites, subject),
    authoritative_effects:normalizeEffects(input.authoritative_effects, subject),
    claimed_outcome:normalizeOutcome(input.claimed_outcome),
  });
}

export async function projectTransitionCertificateFingerprint(raw) {
  return sha256Text(canonicalJson(assertProjectTransitionCertificate(raw)));
}
