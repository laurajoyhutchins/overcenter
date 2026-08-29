function fail(message) {
    const error = new Error(message);
    error.code = 'ORCHESTRATION_DRIVE_REQUEST_INVALID';
    throw error;
}
function runId(value) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized || normalized.length > 512)
        fail('run_id is invalid');
    return normalized;
}
function boundedLimit(value) {
    const limit = value == null ? 8 : Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > 32)
        throw new TypeError('max_advances must be an integer from 1 to 32');
    return limit;
}
function currentState(result) {
    if (!result)
        return null;
    return Object.freeze({
        outcome: result.outcome,
        project_ref: result.project_ref ?? null,
        frontier: Object.freeze([...(result.frontier ?? [])]),
        off_nominal: Object.freeze([...(result.off_nominal ?? [])]),
        authority: result.authority ? Object.freeze({ ...result.authority }) : null,
        horizon: result.horizon ?? null,
    });
}
function unresolvedState(error) {
    return Object.freeze({
        code: String(error.code || 'ORCHESTRATION_DRIVE_ADVANCE_FAILED'),
        message: String(error.message || error),
        may_have_mutated: error.may_have_mutated === true || error.details?.may_have_mutated === true,
    });
}
function driveResult(run_id, stop_class, attempted, confirmed, deterministicCompleted, current, unresolved = null) {
    const agentBoundary = current?.outcome === 'AGENT_EXECUTION_REQUIRED'
        ? Object.freeze({
            transition: current.transition ?? null,
            lease_ref: current.lease_ref ?? null,
            authority: current.authority ? Object.freeze({ ...current.authority }) : null,
        })
        : null;
    return Object.freeze({
        ok: true,
        schema: 'orchestration-drive-v1',
        run_id,
        stop_class,
        transitions_attempted: attempted,
        transitions_confirmed: confirmed,
        deterministic_transitions_completed: deterministicCompleted,
        current: currentState(current),
        agent_boundary: agentBoundary,
        unresolved,
    });
}
function authorityChanged(error) {
    const code = String(error.code || '');
    return code.includes('AUTHORITY_STALE') || code.includes('AUTHORITY_CHANGED') || code === 'PROJECT_GRAPH_REVISION_STALE';
}
function indeterminate(error) {
    const code = String(error.code || '');
    return code.includes('INDETERMINATE') || error.may_have_mutated === true || error.details?.may_have_mutated === true;
}
export function createOrchestrationDriveService(options) {
    if (!options || typeof options.advance !== 'function')
        throw new TypeError('advance is required');
    const maxAdvances = boundedLimit(options.max_advances);
    async function drive(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            fail('input must be an object');
        const unknown = Object.keys(input).filter((key) => key !== 'run_id');
        if (unknown.length)
            fail('input contains unsupported fields');
        const id = runId(input.run_id);
        let attempted = 0;
        let confirmed = 0;
        let deterministicCompleted = 0;
        let current = null;
        while (attempted < maxAdvances) {
            try {
                current = await options.advance(Object.freeze({ run_id: id }));
            }
            catch (caught) {
                attempted += 1;
                const error = caught;
                if (authorityChanged(error))
                    return driveResult(id, 'AUTHORITY_CHANGED', attempted, confirmed, deterministicCompleted, current, unresolvedState(error));
                if (indeterminate(error))
                    return driveResult(id, 'INDETERMINATE', attempted, confirmed, deterministicCompleted, current, unresolvedState(error));
                throw error;
            }
            attempted += 1;
            if (!current || current.ok !== true || typeof current.outcome !== 'string') {
                const error = new Error('orchestration.advance returned invalid drive input');
                error.code = 'ORCHESTRATION_DRIVE_ADVANCE_INVALID';
                throw error;
            }
            if (current.outcome === 'TRANSITION_CONFIRMED') {
                confirmed += 1;
                if (current.transition?.executor?.kind === 'operator')
                    deterministicCompleted += 1;
                continue;
            }
            return driveResult(id, current.outcome, attempted, confirmed, deterministicCompleted, current);
        }
        return driveResult(id, 'ADVANCEMENT_LIMIT', attempted, confirmed, deterministicCompleted, current);
    }
    return Object.freeze({ drive });
}
export function statusForOrchestrationDriveError(error) {
    const code = String(error?.code || '');
    if (code === 'ORCHESTRATION_DRIVE_REQUEST_INVALID')
        return 400;
    if (code === 'ORCHESTRATION_DRIVE_ADVANCE_INVALID')
        return 409;
    return null;
}
