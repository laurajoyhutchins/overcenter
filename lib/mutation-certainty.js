const CERTAINTY_RANK = Object.freeze({
    none: 0,
    possible: 1,
    confirmed: 2,
});
function recordOf(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : null;
}
function detailsOf(value) {
    return recordOf(value?.details);
}
export function mergeMutationCertainty(...values) {
    let strongest = 'none';
    for (const value of values) {
        if (CERTAINTY_RANK[value] > CERTAINTY_RANK[strongest])
            strongest = value;
    }
    return strongest;
}
export function mutationCertaintyFromEvidence(value, fallback = 'none') {
    const input = recordOf(value);
    if (!input)
        return fallback;
    const details = detailsOf(input);
    const explicit = input.may_have_mutated ?? details?.may_have_mutated;
    let certainty = explicit === undefined
        ? fallback
        : Boolean(explicit) ? 'possible' : 'none';
    if (input.ok === true)
        certainty = 'confirmed';
    const phase = typeof input.phase === 'string'
        ? input.phase
        : typeof details?.phase === 'string' ? details.phase : '';
    if (phase.startsWith('reconcile.')) {
        certainty = mergeMutationCertainty(certainty, 'possible');
    }
    const errorCode = typeof input.error === 'string' ? input.error : '';
    if (errorCode.includes('INDETERMINATE')) {
        certainty = mergeMutationCertainty(certainty, 'possible');
    }
    return certainty;
}
export function mayHaveMutated(certainty) {
    return certainty !== 'none';
}
