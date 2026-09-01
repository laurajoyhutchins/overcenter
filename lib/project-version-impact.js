export const PROJECT_VERSION_IMPACT_LEVELS = Object.freeze(['none', 'patch', 'minor', 'major']);
const LEVELS = new Set(PROJECT_VERSION_IMPACT_LEVELS);
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function requiredText(value, field, fail) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized)
        fail('INVALID_PROJECT_GRAPH', `${field} must be a non-empty string`, { field });
    return normalized;
}
export function normalizeProjectVersionImpact(raw, transitionId, fail) {
    if (raw === undefined)
        return null;
    if (!isRecord(raw)) {
        fail('INVALID_PROJECT_GRAPH', 'version_impact must be an object when declared', { transition_id: transitionId });
    }
    const unknown = Object.keys(raw).filter((key) => !['level', 'summary'].includes(key)).sort();
    if (unknown.length) {
        fail('INVALID_PROJECT_GRAPH', 'version_impact contains unsupported fields', { transition_id: transitionId, unknown });
    }
    const level = requiredText(raw.level, 'version_impact.level', fail).toLowerCase();
    if (!LEVELS.has(level)) {
        fail('INVALID_PROJECT_GRAPH', 'version_impact.level must be none, patch, minor, or major', {
            transition_id: transitionId,
            level,
        });
    }
    const summary = requiredText(raw.summary, 'version_impact.summary', fail);
    if (summary.length > 1024) {
        fail('INVALID_PROJECT_GRAPH', 'version_impact.summary is too long', { transition_id: transitionId, length: summary.length });
    }
    return Object.freeze({ level, summary });
}
