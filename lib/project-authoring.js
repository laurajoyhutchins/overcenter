import { normalizeProjectExecutor } from './project-graph-contracts.js';
function fail(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    throw error;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value, supported, field) {
    const unknown = Object.keys(value).filter((key) => !supported.includes(key)).sort();
    if (unknown.length)
        fail('PROJECT_DEFINITION_INTENT_INVALID', `${field} contains unsupported fields`, { field, unknown });
}
function text(value, field) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized)
        fail('PROJECT_DEFINITION_INTENT_INVALID', `${field} must be a non-empty string`, { field });
    return normalized;
}
function transition(raw, index) {
    const field = `transitions[${index}]`;
    if (!isRecord(raw))
        fail('PROJECT_DEFINITION_INTENT_INVALID', `${field} must be an object`, { field });
    exactKeys(raw, ['executor', 'id', 'priority', 'requires'], field);
    const id = text(raw.id, `${field}.id`);
    if (!Number.isInteger(raw.priority)) {
        fail('PROJECT_DEFINITION_INTENT_INVALID', `${field}.priority must be an integer`, { field: `${field}.priority` });
    }
    if (!Array.isArray(raw.requires)) {
        fail('PROJECT_DEFINITION_INTENT_INVALID', `${field}.requires must be an array`, { field: `${field}.requires` });
    }
    const requires = raw.requires.map((value, requirementIndex) => text(value, `${field}.requires[${requirementIndex}]`));
    if (new Set(requires).size !== requires.length) {
        fail('PROJECT_DEFINITION_INTENT_INVALID', `${field}.requires contains duplicates`, { id });
    }
    if (requires.includes(id)) {
        fail('PROJECT_DEFINITION_INTENT_INVALID', `${field}.requires cannot contain its own transition id`, { id });
    }
    return Object.freeze({
        id,
        priority: raw.priority,
        requires: Object.freeze(requires),
        executor: normalizeProjectExecutor(raw.executor, id, fail),
    });
}
function assertGraphReferences(transitions) {
    const ids = new Set(transitions.map((item) => item.id));
    if (ids.size !== transitions.length)
        fail('PROJECT_DEFINITION_INTENT_INVALID', 'transition ids must be unique');
    for (const item of transitions) {
        const missing = item.requires.filter((dependency) => !ids.has(dependency)).sort();
        if (missing.length) {
            fail('PROJECT_DEFINITION_INTENT_INVALID', 'transition dependency references a missing transition', { transition_id: item.id, missing });
        }
    }
    const byId = new Map(transitions.map((item) => [item.id, item]));
    const visited = new Set();
    const visiting = new Set();
    const path = [];
    const visit = (id) => {
        if (visited.has(id))
            return;
        if (visiting.has(id)) {
            const start = path.indexOf(id);
            fail('PROJECT_DEFINITION_INTENT_CYCLE', 'project definition intent must be acyclic', { cycle: [...path.slice(start), id] });
        }
        visiting.add(id);
        path.push(id);
        for (const dependency of byId.get(id)?.requires ?? [])
            visit(dependency);
        path.pop();
        visiting.delete(id);
        visited.add(id);
    };
    for (const id of [...ids].sort())
        visit(id);
}
export function normalizeProjectDefinitionIntent(raw) {
    if (!isRecord(raw))
        fail('PROJECT_DEFINITION_INTENT_INVALID', 'project definition intent must be an object');
    exactKeys(raw, ['project_ref', 'transitions'], 'project definition intent');
    if (!Array.isArray(raw.transitions)) {
        fail('PROJECT_DEFINITION_INTENT_INVALID', 'transitions must be an array', { field: 'transitions' });
    }
    const transitions = raw.transitions.map(transition);
    assertGraphReferences(transitions);
    return Object.freeze({
        project_ref: text(raw.project_ref, 'project_ref'),
        transitions: Object.freeze(transitions),
    });
}