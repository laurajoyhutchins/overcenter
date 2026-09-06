import { canonicalJson, sha256Text } from './canonical-json.js';
export const PROJECT_TRANSITION_CERTIFICATE_SCHEMA = 'project-transition-certificate-v1';
export const PROJECT_TRANSITION_OBLIGATION_SCHEMA = 'project-transition-obligation-v1';
export const TRANSITION_CERTIFICATE_FIELD_ROLES = Object.freeze({
    semantic_identity: Object.freeze(['subject.project_ref', 'subject.transition_id', 'subject.obligation_fingerprint', 'claimed_outcome']),
    provenance: Object.freeze(['authority']),
    evidence_references: Object.freeze(['prerequisite_evidence', 'authoritative_effect_evidence', 'settlement_evidence', 'execution_evidence']),
});
function sortedUnique(values) {
    return Object.freeze([...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].sort());
}
function canonicalAcceptance(intent) {
    return Object.freeze([...(intent?.acceptance_evidence ?? [])]
        .map((entry) => Object.freeze({ kind: String(entry.kind), requirement: String(entry.requirement) }))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))));
}
export async function computeTransitionObligationFingerprint(transition) {
    const obligation = Object.freeze({
        schema: PROJECT_TRANSITION_OBLIGATION_SCHEMA,
        transition_id: String(transition.transition_id),
        kind: String(transition.kind),
        desired_outcome: String(transition.execution_intent?.desired_outcome ?? ''),
        acceptance_evidence: canonicalAcceptance(transition.execution_intent),
        dependencies: sortedUnique(transition.dependencies),
    });
    return sha256Text(canonicalJson(obligation));
}
function canonicalPrerequisites(values) {
    return Object.freeze([...values]
        .map((value) => Object.freeze({
        transition_id: String(value.transition_id),
        obligation_fingerprint: String(value.obligation_fingerprint),
        certificate_ref: String(value.certificate_ref),
    }))
        .sort((left, right) => left.transition_id.localeCompare(right.transition_id) || canonicalJson(left).localeCompare(canonicalJson(right))));
}
function canonicalEvidence(values) {
    return Object.freeze([...values]
        .map((value) => Object.freeze({
        kind: String(value.kind),
        ref: String(value.ref),
        subject: Object.freeze({
            project_ref: String(value.subject.project_ref),
            transition_id: String(value.subject.transition_id),
            obligation_fingerprint: String(value.subject.obligation_fingerprint),
        }),
    }))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))));
}
async function semanticIdentity(subject, claimedOutcome) {
    return sha256Text(canonicalJson({
        schema: PROJECT_TRANSITION_CERTIFICATE_SCHEMA,
        subject,
        claimed_outcome: claimedOutcome,
    }));
}
export async function buildTransitionCertificate(input) {
    const obligationFingerprint = await computeTransitionObligationFingerprint(input.transition);
    const subject = Object.freeze({
        project_ref: String(input.project_ref),
        transition_id: String(input.transition.transition_id),
        obligation_fingerprint: obligationFingerprint,
    });
    const claimedOutcome = String(input.claimed_outcome);
    return Object.freeze({
        schema: PROJECT_TRANSITION_CERTIFICATE_SCHEMA,
        semantic_identity: await semanticIdentity(subject, claimedOutcome),
        subject,
        authority: Object.freeze({ ...input.authority }),
        prerequisite_evidence: canonicalPrerequisites(input.prerequisite_evidence),
        authoritative_effect_evidence: canonicalEvidence(input.authoritative_effect_evidence),
        settlement_evidence: canonicalEvidence(input.settlement_evidence),
        execution_evidence: canonicalEvidence(input.execution_evidence),
        claimed_outcome: claimedOutcome,
    });
}
function subjectMatches(evidence, subject) {
    return evidence.subject.project_ref === subject.project_ref
        && evidence.subject.transition_id === subject.transition_id
        && evidence.subject.obligation_fingerprint === subject.obligation_fingerprint;
}
export async function verifyTransitionCertificate(certificate, transition, authority) {
    const reasons = [];
    const expectedFingerprint = await computeTransitionObligationFingerprint(transition);
    if (certificate.schema !== PROJECT_TRANSITION_CERTIFICATE_SCHEMA)
        reasons.push('CERTIFICATE_SCHEMA_MISMATCH');
    if (certificate.subject.transition_id !== transition.transition_id || certificate.subject.obligation_fingerprint !== expectedFingerprint) {
        reasons.push('OBLIGATION_IDENTITY_MISMATCH');
    }
    if (canonicalJson(certificate.authority) !== canonicalJson(authority))
        reasons.push('AUTHORITY_PROVENANCE_MISMATCH');
    const expectedDependencies = sortedUnique(transition.dependencies);
    const actualDependencies = sortedUnique(certificate.prerequisite_evidence.map((entry) => entry.transition_id));
    if (canonicalJson(expectedDependencies) !== canonicalJson(actualDependencies))
        reasons.push('PREREQUISITE_CLOSURE_INCOMPLETE');
    const evidence = [
        ...certificate.authoritative_effect_evidence,
        ...certificate.settlement_evidence,
        ...certificate.execution_evidence,
    ];
    if (certificate.authoritative_effect_evidence.length === 0)
        reasons.push('AUTHORITATIVE_EFFECT_EVIDENCE_MISSING');
    if (certificate.settlement_evidence.length === 0)
        reasons.push('SETTLEMENT_EVIDENCE_MISSING');
    if (certificate.execution_evidence.length === 0)
        reasons.push('EXECUTION_EVIDENCE_MISSING');
    if (evidence.some((entry) => !subjectMatches(entry, certificate.subject)))
        reasons.push('EVIDENCE_SUBJECT_MISMATCH');
    const expectedSemanticIdentity = await semanticIdentity(certificate.subject, certificate.claimed_outcome);
    if (certificate.semantic_identity !== expectedSemanticIdentity)
        reasons.push('CERTIFICATE_IDENTITY_MISMATCH');
    return Object.freeze({ accepted: reasons.length === 0, reasons: Object.freeze([...new Set(reasons)]) });
}