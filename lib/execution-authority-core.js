import { canonicalJson, sha256Text } from './canonical-json.js';
import { repositoryIdentity } from './work-identity.js';
import { isExecutionGate, normalizeAllowedExecutionGates, normalizeExecutionAuthorityLocator, } from './execution-authority-contracts.js';
export class ExecutionAuthorityError extends Error {
    code;
    details;
    httpStatus;
    constructor(code, message, details = null, httpStatus = 409) {
        super(message);
        this.name = 'ExecutionAuthorityError';
        this.code = code;
        this.details = details;
        this.httpStatus = httpStatus;
    }
}
function fail(code, message, details = null, httpStatus = 409) {
    throw new ExecutionAuthorityError(code, message, details, httpStatus);
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function parseJson(value) {
    if (value === null || value === undefined || typeof value === 'object')
        return value;
    try {
        return JSON.parse(String(value));
    }
    catch {
        return value;
    }
}
function instant(value) {
    const milliseconds = Date.parse(String(value || ''));
    return Number.isFinite(milliseconds) ? milliseconds : null;
}
function errorCode(error) {
    return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}
function errorDetails(error) {
    return isRecord(error) ? error.details ?? null : null;
}
function projectionMatchesExpected(current, expected) {
    if (!isRecord(expected))
        return false;
    const comparable = {};
    for (const key of Object.keys(expected))
        comparable[key] = current[key];
    return canonicalJson(comparable) === canonicalJson(expected);
}
function projectionDiff(expected, current) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(current)])].sort();
    return keys.filter(key => canonicalJson(expected[key]) !== canonicalJson(current[key]));
}
function requiredLeaseIdentity(lease) {
    const leaseId = typeof lease.lease_id === 'string' ? lease.lease_id.trim() : '';
    const workRef = typeof lease.work_ref === 'string' ? lease.work_ref.trim() : '';
    const runId = typeof lease.run_id === 'string' ? lease.run_id.trim() : '';
    if (!leaseId || !workRef || !runId || !isExecutionGate(lease.gate)) {
        return fail('EXECUTION_AUTHORITY_INVALID', 'execution authority lease is missing durable identity', {
            lease_id: lease.lease_id || null,
            work_ref: lease.work_ref || null,
            run_id: lease.run_id || null,
            gate: lease.gate || null,
        });
    }
    return {
        leaseId: leaseId,
        workRef: workRef,
        runId: runId,
        gate: executionGate(lease.gate),
    };
}
function executionGate(value) {
    if (!isExecutionGate(value))
        throw new Error(`invalid execution gate ${value}`);
    return value;
}
function nonEmptyText(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || null;
}
export function createExecutionAuthorityService({ store, authoritative, executionProjection, projectTransitions = null, now = () => new Date().toISOString(), } = {}) {
    if (!store || typeof store.getLeaseByTokenHash !== 'function' || typeof store.getSlot !== 'function' || typeof store.getRun !== 'function') {
        throw new Error('execution authority store must provide lease, slot, and run reads');
    }
    if (!authoritative || typeof authoritative.getIssue !== 'function') {
        throw new Error('execution authority requires authoritative work reads');
    }
    if (typeof executionProjection !== 'function') {
        throw new Error('execution authority requires an execution projection function');
    }
    return {
        async require(input = {}) {
            const locator = normalizeExecutionAuthorityLocator(input, () => repositoryIdentity(input.repository) || null, fail);
            const leaseToken = 'lease_token' in locator ? locator.lease_token : '';
            const leaseRef = 'lease_ref' in locator ? locator.lease_ref : '';
            const getLeaseById = store.getLeaseById;
            if (leaseRef && typeof getLeaseById !== 'function') {
                fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not read execution authority by lease reference', {
                    phase: 'lease_read',
                }, 503);
            }
            const allowedGates = normalizeAllowedExecutionGates(input.allowed_gates);
            let lease;
            try {
                lease = leaseRef
                    ? await getLeaseById(leaseRef)
                    : await store.getLeaseByTokenHash(await sha256Text(leaseToken));
            }
            catch (error) {
                fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not read execution authority state', {
                    phase: 'lease_read',
                    upstream_code: errorCode(error),
                }, 503);
            }
            if (!lease)
                fail('EXECUTION_AUTHORITY_INVALID', 'execution authority locator is unknown');
            const observedNow = instant(now());
            if (observedNow === null)
                throw new Error('execution authority clock returned an invalid instant');
            const leaseExpiry = instant(lease.expires_at);
            const hardExpiry = lease.hard_expires_at ? instant(lease.hard_expires_at) : null;
            if (lease.status !== 'active' || leaseExpiry === null || leaseExpiry <= observedNow || (hardExpiry !== null && hardExpiry <= observedNow)) {
                fail('EXECUTION_AUTHORITY_STALE', 'execution authority lease is not active', {
                    work_ref: lease.work_ref || null,
                    lease_id: lease.lease_id || null,
                    gate: lease.gate || null,
                    reason: lease.status !== 'active' ? 'lease_status' : 'lease_expired',
                });
            }
            const { leaseId, workRef, runId, gate } = requiredLeaseIdentity(lease);
            if (!allowedGates.has(gate)) {
                fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'execution authority does not cover this mutation gate', {
                    work_ref: workRef,
                    lease_id: leaseId,
                    gate,
                    allowed_gates: [...allowedGates].sort(),
                });
            }
            let slot;
            let run;
            try {
                [slot, run] = await Promise.all([
                    store.getSlot(workRef, gate),
                    store.getRun(runId),
                ]);
            }
            catch (error) {
                fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not confirm current execution ownership', {
                    phase: 'ownership_read',
                    upstream_code: errorCode(error),
                }, 503);
            }
            const slotExpiry = instant(slot?.expires_at);
            if (!slot || slot.lease_id !== leaseId || slotExpiry === null || slotExpiry <= observedNow) {
                fail('EXECUTION_AUTHORITY_STALE', 'execution authority no longer owns the active work slot', {
                    work_ref: workRef,
                    lease_id: leaseId,
                    gate,
                    reason: 'slot_not_owned',
                });
            }
            const runDeadline = instant(run?.deadline_at);
            if (!run || run.status !== 'active' || runDeadline === null || runDeadline <= observedNow) {
                fail('EXECUTION_AUTHORITY_STALE', 'execution authority run is no longer active', {
                    work_ref: workRef,
                    lease_id: leaseId,
                    run_id: runId,
                    gate,
                    reason: 'run_not_active',
                });
            }
            const parsedReceipt = parseJson(lease.claim_receipt);
            const claimReceipt = isRecord(parsedReceipt) ? parsedReceipt : null;
            if (claimReceipt?.subject === 'project_transition') {
                const subject = isRecord(claimReceipt.project_transition) ? claimReceipt.project_transition : null;
                const requestedRepository = repositoryIdentity(input.repository);
                const subjectRepository = repositoryIdentity(subject?.repository);
                const subjectProjectRef = nonEmptyText(subject?.project_ref);
                const subjectTransitionId = nonEmptyText(subject?.transition_id);
                if (!subject || !subjectProjectRef || !subjectTransitionId || !requestedRepository || !subjectRepository) {
                    fail('EXECUTION_AUTHORITY_INVALID', 'project transition execution authority is missing durable subject identity', {
                        lease_id: leaseId,
                    });
                }
                if (requestedRepository !== subjectRepository) {
                    fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'project transition execution authority does not cover the requested repository', {
                        lease_id: leaseId,
                        repository: requestedRepository || null,
                        authorized_repository: subjectRepository || null,
                    });
                }
                if (!projectTransitions || typeof projectTransitions.require !== 'function') {
                    fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'project transition execution authority validator is unavailable', {
                        phase: 'project_transition_authority_read',
                    }, 503);
                }
                let verified;
                try {
                    verified = await projectTransitions.require({
                        lease_ref: leaseId,
                        run_id: runId,
                        project_ref: subjectProjectRef,
                        transition_id: subjectTransitionId,
                        repository: subjectRepository,
                    });
                }
                catch (error) {
                    const code = errorCode(error);
                    if (String(code || '').startsWith('PROJECT_TRANSITION_')) {
                        fail('EXECUTION_AUTHORITY_STALE', 'project transition execution authority is no longer valid', {
                            phase: 'project_transition_authority_read',
                            upstream_code: code,
                            upstream_details: errorDetails(error),
                        });
                    }
                    throw error;
                }
                const verifiedRecord = isRecord(verified) ? verified : null;
                const verifiedRepository = repositoryIdentity(verifiedRecord?.repository);
                const verifiedProjectRef = nonEmptyText(verifiedRecord?.project_ref);
                const verifiedTransitionId = nonEmptyText(verifiedRecord?.transition_id);
                if (!verifiedRecord || verifiedRecord.subject !== 'project_transition' || verifiedRepository !== subjectRepository || !verifiedProjectRef || !verifiedTransitionId) {
                    fail('EXECUTION_AUTHORITY_INVALID', 'project transition authority validator returned inconsistent subject evidence', {
                        lease_id: leaseId,
                    });
                }
                return {
                    subject: 'project_transition',
                    work_ref: workRef,
                    lease_id: leaseId,
                    lease_ref: leaseId,
                    run_id: runId,
                    gate,
                    repository: subjectRepository,
                    project_ref: verifiedProjectRef,
                    transition_id: verifiedTransitionId,
                    authority: verifiedRecord.authority || null,
                    graph_fingerprint: nonEmptyText(verifiedRecord.graph_fingerprint),
                };
            }
            const claimProjection = claimReceipt?.execution_projection;
            if (!isRecord(claimProjection)) {
                fail('EXECUTION_AUTHORITY_INVALID', 'execution authority lacks a durable execution projection', {
                    work_ref: workRef,
                    lease_id: leaseId,
                });
            }
            const requestedRepository = repositoryIdentity(input.repository);
            const leaseRepository = repositoryIdentity(claimProjection.repository);
            if (!requestedRepository || !leaseRepository || requestedRepository !== leaseRepository) {
                fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'execution authority does not cover the requested repository', {
                    work_ref: workRef,
                    lease_id: leaseId,
                    gate,
                    repository: requestedRepository || null,
                    authorized_repository: leaseRepository || null,
                });
            }
            let issue;
            try {
                issue = await authoritative.getIssue(workRef);
            }
            catch (error) {
                fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not re-read authoritative work state', {
                    work_ref: workRef,
                    lease_id: leaseId,
                    phase: 'authoritative_work_read',
                    upstream_code: errorCode(error),
                }, 503);
            }
            const currentProjection = executionProjection(issue);
            if (!projectionMatchesExpected(currentProjection, claimProjection)) {
                fail('EXECUTION_AUTHORITY_STALE', 'authoritative work state changed after the lease was claimed', {
                    work_ref: workRef,
                    lease_id: leaseId,
                    gate,
                    reason: 'work_state_changed',
                    changed_fields: projectionDiff(claimProjection, currentProjection),
                });
            }
            return {
                work_ref: workRef,
                lease_id: leaseId,
                run_id: runId,
                gate,
                repository: leaseRepository,
                execution_fingerprint: nonEmptyText(claimReceipt?.execution_fingerprint),
            };
        },
    };
}
