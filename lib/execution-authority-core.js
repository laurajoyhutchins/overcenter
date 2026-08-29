import { canonicalJson, sha256Text } from './canonical-json.js';
import { repositoryIdentity } from './work-identity.js';
import { normalizeExecutionAuthorityLocator, } from './execution-authority-contracts.js';
import { isLegacyWorkExecutionGate, normalizeAllowedLegacyWorkExecutionGates, } from './legacy-work-execution-authority-contracts.js';
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
    const runId = typeof lease.run_id === 'string' ? lease.run_id.trim() : '';
    if (!leaseId || !runId) {
        return fail('EXECUTION_AUTHORITY_INVALID', 'execution authority lease is missing durable identity', {
            lease_id: lease.lease_id || null,
            run_id: lease.run_id || null,
        });
    }
    return { leaseId: leaseId, runId: runId };
}
function requiredLegacyWorkIdentity(lease) {
    const workRef = typeof lease.work_ref === 'string' ? lease.work_ref.trim() : '';
    if (!workRef || !isLegacyWorkExecutionGate(lease.gate)) {
        return fail('EXECUTION_AUTHORITY_INVALID', 'legacy work execution authority is missing durable work identity', {
            work_ref: lease.work_ref || null,
            gate: lease.gate || null,
        });
    }
    return { workRef: workRef, gate: lease.gate };
}
function nonEmptyText(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || null;
}
function requireActiveLease(lease, observedNow, leaseId) {
    const leaseExpiry = instant(lease.expires_at);
    const hardExpiry = lease.hard_expires_at ? instant(lease.hard_expires_at) : null;
    if (lease.status !== 'active' || leaseExpiry === null || leaseExpiry <= observedNow || (hardExpiry !== null && hardExpiry <= observedNow)) {
        fail('EXECUTION_AUTHORITY_STALE', 'execution authority lease is not active', {
            lease_id: leaseId,
            reason: lease.status !== 'active' ? 'lease_status' : 'lease_expired',
        });
    }
}
export function createExecutionAuthorityService({ store, authoritative, executionProjection, projectTransitions = null, now = () => new Date().toISOString(), } = {}) {
    if (!store || typeof store.getLeaseByTokenHash !== 'function') {
        throw new Error('execution authority store must provide lease reads');
    }
    return {
        async require(input = {}) {
            const locator = normalizeExecutionAuthorityLocator(input, () => repositoryIdentity(input.repository) || null, fail);
            const leaseToken = 'lease_token' in locator ? locator.lease_token || '' : '';
            const leaseRef = 'lease_ref' in locator ? locator.lease_ref || '' : '';
            const getLeaseById = store.getLeaseById;
            if (leaseRef && typeof getLeaseById !== 'function') {
                fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not read execution authority by lease reference', {
                    phase: 'lease_read',
                }, 503);
            }
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
            const { leaseId, runId } = requiredLeaseIdentity(lease);
            const observedNow = instant(now());
            if (observedNow === null)
                throw new Error('execution authority clock returned an invalid instant');
            requireActiveLease(lease, observedNow, leaseId);
            const parsedReceipt = parseJson(lease.claim_receipt);
            const claimReceipt = isRecord(parsedReceipt) ? parsedReceipt : null;
            if (claimReceipt?.subject === 'project_transition') {
                const subject = isRecord(claimReceipt.project_transition) ? claimReceipt.project_transition : null;
                const requestedRepository = repositoryIdentity(input.repository);
                const subjectRepository = repositoryIdentity(subject?.repository);
                const subjectProjectRef = nonEmptyText(subject?.project_ref);
                const subjectTransitionId = nonEmptyText(subject?.transition_id);
                const subjectGraphFingerprint = nonEmptyText(subject?.graph_fingerprint);
                const subjectTransitionFingerprint = nonEmptyText(subject?.transition_definition_fingerprint);
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
                const verifiedLeaseRef = nonEmptyText(verifiedRecord?.lease_ref);
                const verifiedRunId = nonEmptyText(verifiedRecord?.run_id);
                const verifiedRepository = repositoryIdentity(verifiedRecord?.repository);
                const verifiedProjectRef = nonEmptyText(verifiedRecord?.project_ref);
                const verifiedTransitionId = nonEmptyText(verifiedRecord?.transition_id);
                const verifiedGraphFingerprint = nonEmptyText(verifiedRecord?.graph_fingerprint);
                const verifiedTransitionFingerprint = nonEmptyText(verifiedRecord?.transition_definition_fingerprint);
                if (!verifiedRecord
                    || verifiedRecord.subject !== 'project_transition'
                    || verifiedLeaseRef !== leaseId
                    || verifiedRunId !== runId
                    || verifiedRepository !== subjectRepository
                    || verifiedProjectRef !== subjectProjectRef
                    || verifiedTransitionId !== subjectTransitionId
                    || (subjectGraphFingerprint !== null && verifiedGraphFingerprint !== subjectGraphFingerprint)
                    || (subjectTransitionFingerprint !== null && verifiedTransitionFingerprint !== subjectTransitionFingerprint)) {
                    fail('EXECUTION_AUTHORITY_INVALID', 'project transition authority validator returned inconsistent subject evidence', {
                        lease_id: leaseId,
                    });
                }
                return {
                    subject: 'project_transition',
                    lease_id: leaseId,
                    lease_ref: leaseId,
                    run_id: runId,
                    repository: subjectRepository,
                    project_ref: subjectProjectRef,
                    transition_id: subjectTransitionId,
                    authority: verifiedRecord.authority || null,
                    graph_fingerprint: verifiedGraphFingerprint,
                    transition_definition_fingerprint: verifiedTransitionFingerprint,
                };
            }
            if (!authoritative || typeof authoritative.getIssue !== 'function' || typeof executionProjection !== 'function') {
                fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'legacy work execution authority adapter is unavailable', {
                    phase: 'legacy_work_authority_read',
                }, 503);
            }
            const getSlot = store.getSlot;
            const getRun = store.getRun;
            if (typeof getSlot !== 'function' || typeof getRun !== 'function') {
                fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'legacy work execution authority store is unavailable', {
                    phase: 'legacy_work_ownership_read',
                }, 503);
            }
            const { workRef, gate } = requiredLegacyWorkIdentity(lease);
            const allowedGates = normalizeAllowedLegacyWorkExecutionGates(input.allowed_gates);
            if (!allowedGates.has(gate)) {
                fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'legacy work execution authority does not cover this mutation gate', {
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
                    getSlot(workRef, gate),
                    getRun(runId),
                ]);
            }
            catch (error) {
                fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not confirm current legacy work execution ownership', {
                    phase: 'legacy_work_ownership_read',
                    upstream_code: errorCode(error),
                }, 503);
            }
            const slotExpiry = instant(slot?.expires_at);
            if (!slot || slot.lease_id !== leaseId || slotExpiry === null || slotExpiry <= observedNow) {
                fail('EXECUTION_AUTHORITY_STALE', 'legacy work execution authority no longer owns the active work slot', {
                    work_ref: workRef,
                    lease_id: leaseId,
                    gate,
                    reason: 'slot_not_owned',
                });
            }
            const runDeadline = instant(run?.deadline_at);
            if (!run || run.status !== 'active' || runDeadline === null || runDeadline <= observedNow) {
                fail('EXECUTION_AUTHORITY_STALE', 'legacy work execution authority run is no longer active', {
                    work_ref: workRef,
                    lease_id: leaseId,
                    run_id: runId,
                    gate,
                    reason: 'run_not_active',
                });
            }
            const claimProjection = claimReceipt?.execution_projection;
            if (!isRecord(claimProjection)) {
                fail('EXECUTION_AUTHORITY_INVALID', 'legacy work execution authority lacks a durable execution projection', {
                    work_ref: workRef,
                    lease_id: leaseId,
                });
            }
            const requestedRepository = repositoryIdentity(input.repository);
            const leaseRepository = repositoryIdentity(claimProjection.repository);
            if (!requestedRepository || !leaseRepository || requestedRepository !== leaseRepository) {
                fail('EXECUTION_AUTHORITY_SCOPE_MISMATCH', 'legacy work execution authority does not cover the requested repository', {
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
                fail('EXECUTION_AUTHORITY_UNAVAILABLE', 'Overcenter could not re-read authoritative legacy work state', {
                    work_ref: workRef,
                    lease_id: leaseId,
                    phase: 'legacy_work_authority_read',
                    upstream_code: errorCode(error),
                }, 503);
            }
            const currentProjection = executionProjection(issue);
            if (!projectionMatchesExpected(currentProjection, claimProjection)) {
                fail('EXECUTION_AUTHORITY_STALE', 'authoritative legacy work state changed after the lease was claimed', {
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
