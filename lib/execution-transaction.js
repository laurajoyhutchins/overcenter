const TRANSITIONS = {
    prepared: ['executing', 'rejected'],
    executing: ['effect_uncertain', 'effect_confirmed', 'effect_absent', 'rejected', 'escalated'],
    effect_uncertain: ['effect_confirmed', 'effect_absent', 'escalated'],
    effect_confirmed: ['settled', 'escalated'],
    effect_absent: ['settled', 'escalated'],
    settled: [],
    rejected: [],
    escalated: [],
};
const CERTAINTY_RANK = {
    definitely_not_mutated: 0,
    may_have_mutated: 1,
    confirmed_mutated: 2,
};
function recordOf(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function requiredText(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw Object.assign(new Error(`${field} is required`), {
            code: 'EXECUTION_TRANSACTION_INVALID',
            field,
        });
    }
    return value;
}
function nonNegativeInteger(value, field) {
    if (!Number.isInteger(value) || Number(value) < 0) {
        throw Object.assign(new Error(`${field} must be a non-negative integer`), {
            code: 'EXECUTION_TRANSACTION_INVALID',
            field,
        });
    }
    return Number(value);
}
function validLifecycle(value) {
    return typeof value === 'string' && Object.hasOwn(TRANSITIONS, value);
}
function validCertainty(value) {
    return value === 'definitely_not_mutated' ||
        value === 'may_have_mutated' ||
        value === 'confirmed_mutated';
}
export function canTransition(from, to) {
    return TRANSITIONS[from].includes(to);
}
export function mutationCertaintyFromFacts(facts) {
    if ('status' in facts) {
        if (facts.status === 'confirmed')
            return 'confirmed_mutated';
        if (facts.status === 'absent')
            return 'definitely_not_mutated';
        return 'may_have_mutated';
    }
    if (facts.transport === 'rejected' && facts.committed === false) {
        return 'definitely_not_mutated';
    }
    if (facts.transport === 'accepted' && facts.committed === true) {
        return 'confirmed_mutated';
    }
    return 'may_have_mutated';
}
export function classifyRecovery(snapshot) {
    if (snapshot.settled || snapshot.lifecycle === 'settled' || snapshot.lifecycle === 'escalated') {
        return 'escalate';
    }
    if (snapshot.mutation_certainty === 'confirmed_mutated' ||
        snapshot.lifecycle === 'effect_confirmed') {
        return 'settle_confirmed';
    }
    if (snapshot.mutation_certainty === 'definitely_not_mutated' &&
        (snapshot.lifecycle === 'effect_absent' || snapshot.lifecycle === 'effect_uncertain')) {
        return 'settle_no_effect';
    }
    if (snapshot.mutation_certainty === 'may_have_mutated' ||
        snapshot.lifecycle === 'effect_uncertain') {
        return 'confirm_only';
    }
    if (snapshot.lifecycle === 'prepared' ||
        snapshot.lifecycle === 'executing' ||
        snapshot.lifecycle === 'rejected') {
        return 'retry_before_effect';
    }
    return 'escalate';
}
export function assertExecutionIdentity(value) {
    const identity = recordOf(value);
    if (!identity)
        throw new Error('execution identity must be an object');
    for (const field of [
        'execution_id',
        'operation_id',
        'project_ref',
        'subject_key',
        'subject_kind',
        'run_id',
        'lease_ref',
        'authority_repository',
        'authority_revision',
        'graph_fingerprint',
        'transition_fingerprint',
        'operation_kind',
        'idempotency_scope',
        'idempotency_key',
        'intent_sha256',
    ]) {
        requiredText(identity[field], field);
    }
    nonNegativeInteger(identity.lease_epoch, 'lease_epoch');
    nonNegativeInteger(identity.authority_epoch, 'authority_epoch');
}
export function assertExecutionSnapshot(value) {
    const snapshot = recordOf(value);
    if (!snapshot)
        throw new Error('execution snapshot must be an object');
    assertExecutionIdentity(snapshot.identity);
    if (!validLifecycle(snapshot.lifecycle)) {
        throw new Error('execution snapshot lifecycle is invalid');
    }
    if (!validCertainty(snapshot.mutation_certainty)) {
        throw new Error('execution snapshot mutation certainty is invalid');
    }
    nonNegativeInteger(snapshot.attempt_epoch, 'attempt_epoch');
    if (!Array.isArray(snapshot.proof_ids) || snapshot.proof_ids.some((proofId) => typeof proofId !== 'string')) {
        throw new Error('execution snapshot proof_ids is invalid');
    }
    if (typeof snapshot.settled !== 'boolean') {
        throw new Error('execution snapshot settled is invalid');
    }
}
export function assertSettlementReceipt(value) {
    const receipt = recordOf(value);
    if (!receipt)
        throw new Error('settlement receipt must be an object');
    if (receipt.schema !== 'settlement-receipt-v1' || receipt.lifecycle !== 'settled') {
        throw new Error('settlement receipt schema is invalid');
    }
    for (const field of [
        'execution_id',
        'operation_id',
        'authority_revision',
        'evidence_sha256',
    ]) {
        requiredText(receipt[field], field);
    }
    nonNegativeInteger(receipt.authority_epoch, 'authority_epoch');
    if (!['completed', 'no_effect', 'rejected', 'escalated'].includes(String(receipt.disposition))) {
        throw new Error('settlement receipt disposition is invalid');
    }
}
export const executionTransactionInternals = Object.freeze({
    certaintyRank: CERTAINTY_RANK,
    transitions: TRANSITIONS,
});
