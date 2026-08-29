const BINDINGS = Object.freeze({
    'LJH-522': Object.freeze({
        project_ref: 'github:laurajoyhutchins/overcenter',
        transition_id: 'require-production-reachability',
        authority_issue: 'laurajoyhutchins/overcenter#175',
    }),
});
export const OVERCENTER_COMPATIBILITY_TRANSITION_BINDINGS = BINDINGS;
export function resolveCompatibilityTransitionBinding(workRef) {
    const key = typeof workRef === 'string' ? workRef.trim() : '';
    return key && Object.prototype.hasOwnProperty.call(BINDINGS, key) ? BINDINGS[key] ?? null : null;
}