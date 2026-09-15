import { semanticCommandDescriptor } from './semantic-command-descriptors.js';
const CANDIDATE_EVIDENCE_KINDS = Object.freeze(new Set([
    'candidate_revision',
    'candidate',
    'verified_candidate',
]));
function evidenceKind(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? String(value.kind || '').trim().toLowerCase()
        : '';
}
export function settlementRequiresAuthoritativeEffect(input) {
    return input?.disposition === 'completed'
        && (input?.evidence || []).some((entry) => CANDIDATE_EVIDENCE_KINDS.has(evidenceKind(entry)));
}
function unconfirmedAuthoritativeEffect(confirmation) {
    const mayHaveMutated = confirmation?.mutation_certainty === 'possible' || confirmation?.may_have_mutated === true;
    const error = new Error('verified candidate evidence cannot complete a project transition before deterministic authoritative-provider confirmation');
    error.code = 'PROJECT_ADVANCE_AUTHORITATIVE_EFFECT_UNCONFIRMED';
    error.may_have_mutated = mayHaveMutated;
    error.details = Object.freeze({
        may_have_mutated: mayHaveMutated,
        required_continuation: 'deterministic_authoritative_effect_reconciliation',
        ...(confirmation?.reason ? { confirmation_reason: String(confirmation.reason) } : {}),
    });
    throw error;
}
export function bindAuthoritativeEffectSettlement(input, confirmation = null) {
    const evidence = input?.evidence || [];
    if (!settlementRequiresAuthoritativeEffect(input))
        return evidence;
    if (confirmation?.confirmed !== true)
        unconfirmedAuthoritativeEffect(confirmation);
    const confirmedEvidence = Array.isArray(confirmation.evidence) ? confirmation.evidence : [];
    if (!confirmedEvidence.some((entry) => evidenceKind(entry) === 'authority_readback')) {
        unconfirmedAuthoritativeEffect({ ...confirmation, reason: 'authoritative_readback_missing' });
    }
    return Object.freeze([...evidence, ...confirmedEvidence]);
}
const descriptor = semanticCommandDescriptor('work.settle');
export const WORK_SETTLE_INPUT_SCHEMA = descriptor.input_schema;
export const WORK_SETTLE_SEMANTIC_FIELDS = descriptor.semantic_fields;
export const WORK_SETTLE_REQUIRED_FIELDS = descriptor.required_fields;
