export const LEGACY_WORK_EXECUTION_GATES = [
    'lane:enable',
    'lane:source-implementation',
    'lane:repo-implementation',
    'lane:integration',
    'lane:verification',
];
const LEGACY_WORK_EXECUTION_GATE_SET = new Set(LEGACY_WORK_EXECUTION_GATES);
export function isLegacyWorkExecutionGate(value) {
    return typeof value === 'string' && LEGACY_WORK_EXECUTION_GATE_SET.has(value);
}
export function normalizeAllowedLegacyWorkExecutionGates(value) {
    const allowedGates = new Set(Array.isArray(value) ? value.map(entry => String(entry)) : []);
    if (allowedGates.size === 0)
        throw new Error('legacy work execution authority allowed_gates must be non-empty');
    return allowedGates;
}
