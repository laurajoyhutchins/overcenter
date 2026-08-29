import { boundedEvidenceProjection, boundedEvidenceText } from './bounded-evidence.js';
import { EXECUTION_EVIDENCE_SCHEMA as EXECUTION_EVIDENCE_SCHEMA_CONTRACT, NO_EXTERNAL_MUTATION_COMMANDS, VERIFIED_EXTERNAL_EFFECT_COMMANDS, } from './execution-evidence-contracts.js';
export const EXECUTION_EVIDENCE_SCHEMA = EXECUTION_EVIDENCE_SCHEMA_CONTRACT;
function row(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function array(value) { return Array.isArray(value) ? value : []; }
function text(value, max = 512) { return boundedEvidenceText(value, max); }
function time(value) { return value == null ? null : String(value); }
function id(value) { return value == null ? '' : String(value); }
function field(value, key) { return row(value)[key]; }
function compareByTimeAndId(timeKey, idKey) {
    return (left, right) => {
        const leftTime = time(field(left, timeKey)) || '';
        const rightTime = time(field(right, timeKey)) || '';
        if (leftTime !== rightTime)
            return leftTime.localeCompare(rightTime);
        return id(field(left, idKey)).localeCompare(id(field(right, idKey)));
    };
}
function compareInvocations(left, right) {
    const a = Number(field(left, 'sequence') ?? Number.MAX_SAFE_INTEGER);
    const b = Number(field(right, 'sequence') ?? Number.MAX_SAFE_INTEGER);
    if (a !== b)
        return a - b;
    return id(field(left, 'invocation_id')).localeCompare(id(field(right, 'invocation_id')));
}
function compareHorizons(left, right) {
    const a = Number(field(left, 'generation') ?? Number.MAX_SAFE_INTEGER);
    const b = Number(field(right, 'generation') ?? Number.MAX_SAFE_INTEGER);
    if (a !== b)
        return a - b;
    return id(field(left, 'horizon_id')).localeCompare(id(field(right, 'horizon_id')));
}
function projectionObject(value) {
    const projected = boundedEvidenceProjection(value);
    return projected && typeof projected === 'object' && !Array.isArray(projected) ? projected : {};
}
function projectRun(run) {
    if (!run)
        return null;
    const value = row(run);
    return {
        run_id: text(value.run_id),
        worker: text(value.worker, 256),
        mode: text(value.mode, 32),
        continuation_key: text(value.continuation_key),
        scope: projectionObject(value.scope),
        status: text(value.status, 64),
        disposition: text(value.disposition, 64),
        started_at: time(value.started_at),
        deadline_at: time(value.deadline_at),
        finished_at: time(value.finished_at),
        stop_reason: text(value.stop_reason, 2000),
        predecessor_run_id: text(value.predecessor_run_id),
    };
}
function projectTarget(run) {
    const value = row(run);
    if (!value.target || typeof value.target !== 'object' || Array.isArray(value.target))
        return null;
    return {
        projection: projectionObject(value.target),
        target_sha256: text(value.target_sha256, 128),
        base_start_request_sha256: text(value.base_start_request_sha256, 128),
    };
}
function projectLease(lease) {
    const value = row(lease);
    return {
        lease_id: text(value.lease_id, 128),
        run_id: text(value.run_id),
        work_ref: text(value.work_ref, 128),
        gate: text(value.gate, 128),
        status: text(value.status, 64),
        created_at: time(value.created_at),
        expires_at: time(value.expires_at),
        settled_at: time(value.settled_at),
        previous_state: text(value.previous_state, 128),
        previous_lane: text(value.previous_lane, 128),
        claim_revision: text(value.claim_revision),
        active_revision: text(value.active_revision),
    };
}
function projectCheckpoint(checkpoint) {
    const value = row(checkpoint);
    return {
        checkpoint_id: text(value.checkpoint_id, 128),
        source_ref: value.checkpoint_id ? `checkpoint:${String(value.checkpoint_id)}` : null,
        lease_id: text(value.lease_id, 128),
        checkpoint_sha256: text(value.checkpoint_sha256, 128),
        created_at: time(value.created_at),
        checkpoint: boundedEvidenceProjection(value.checkpoint ?? {}),
    };
}
function matchingResolutions(invocation, resolutions) {
    const invocationId = field(invocation, 'invocation_id');
    return array(resolutions)
        .filter((resolution) => field(resolution, 'invocation_id') === invocationId)
        .sort(compareByTimeAndId('created_at', 'resolution_id'));
}
function commandSpecificEffectConfirmed(invocation) {
    if (field(invocation, 'outcome') !== 'succeeded')
        return false;
    const command = field(invocation, 'command');
    const resultProjection = field(invocation, 'result_projection');
    const result = resultProjection && typeof resultProjection === 'object' && !Array.isArray(resultProjection)
        ? resultProjection
        : {};
    if (VERIFIED_EXTERNAL_EFFECT_COMMANDS.includes(String(command)))
        return result.verified === true;
    if (command === 'github.apply_changeset')
        return Boolean(result.commit_sha && result.new_head);
    if (command === 'work.claim')
        return Boolean(result.lease_id && result.authoritative_revision);
    if (command === 'work.settle')
        return Boolean(result.lease_id && result.settlement_authoritative_revision);
    if (command === 'github.integration.reconcile')
        return Boolean(result.merge_commit_sha);
    if (command === 'linear.archive')
        return result.archived === true || result.alreadyArchived === true;
    return false;
}
export function deriveMutationCertainty(invocation, resolutions = []) {
    const command = field(invocation, 'command');
    if (NO_EXTERNAL_MUTATION_COMMANDS.includes(String(command)))
        return 'not_applicable';
    const matching = matchingResolutions(invocation, resolutions);
    if (matching.some((resolution) => field(resolution, 'resolution_kind') === 'externally_confirmed'))
        return 'confirmed_present';
    if (matching.some((resolution) => field(resolution, 'resolution_kind') === 'definitively_not_applied'))
        return 'definitively_absent';
    if (field(invocation, 'may_have_mutated') === false)
        return 'definitively_absent';
    if (commandSpecificEffectConfirmed(invocation))
        return 'confirmed_present';
    if (field(invocation, 'outcome') === 'indeterminate' || field(invocation, 'may_have_mutated') === true)
        return 'unknown';
    return 'unknown';
}
function projectCommand(invocation, resolutions) {
    const value = row(invocation);
    const matching = matchingResolutions(invocation, resolutions);
    return {
        invocation_id: text(value.invocation_id, 128),
        source_ref: value.invocation_id ? `invocation:${String(value.invocation_id)}` : null,
        sequence: value.sequence == null ? null : Number(value.sequence),
        command: text(value.command, 128),
        target: {
            kind: text(value.target_kind, 128),
            ref: text(value.target_ref),
        },
        started_at: time(value.started_at),
        completed_at: time(value.completed_at),
        outcome: text(value.outcome, 64),
        error: {
            code: text(value.error_code, 128),
            class: text(value.error_class, 128),
            retryable: typeof value.retryable === 'boolean' ? value.retryable : null,
            rejection: typeof value.rejection === 'boolean' ? value.rejection : null,
        },
        may_have_mutated: typeof value.may_have_mutated === 'boolean' ? value.may_have_mutated : null,
        request_sha256: text(value.request_sha256, 128),
        result_sha256: text(value.result_sha256, 128),
        request: boundedEvidenceProjection(value.request_projection ?? {}),
        result: boundedEvidenceProjection(value.result_projection ?? {}),
        effect: { mutation_certainty: deriveMutationCertainty(invocation, matching) },
        resolution_refs: matching.map((resolution) => {
            const resolutionId = field(resolution, 'resolution_id');
            return resolutionId ? `resolution:${String(resolutionId)}` : null;
        }).filter((value) => Boolean(value)),
    };
}
function settlementEvidenceRefs(plan) {
    const value = row(plan);
    const replay = row(value.replay_request);
    const source = array(value.evidence).length ? array(value.evidence) : array(replay.evidence);
    return source.slice(0, 25).map((item) => {
        const entry = row(item);
        const kind = text(entry.kind, 128);
        const ref = text(entry.ref, 1000);
        return kind && ref ? { kind, ref } : null;
    }).filter((value) => Boolean(value));
}
function projectSettlement(lease) {
    const value = row(lease);
    const receipt = value.settle_receipt && typeof value.settle_receipt === 'object' && !Array.isArray(value.settle_receipt)
        ? value.settle_receipt
        : null;
    if (!receipt)
        return null;
    return {
        lease_id: text(value.lease_id, 128),
        source_ref: value.lease_id ? `lease:${String(value.lease_id)}:settlement` : null,
        work_ref: text(value.work_ref, 128),
        gate: text(value.gate, 128),
        settlement_disposition: text(receipt.disposition, 64),
        settled_at: time(value.settled_at ?? receipt.settled_at),
        evidence_refs: settlementEvidenceRefs(value.settle_plan),
        authority_after: {
            state: text(receipt.current_state, 128),
            lane: text(receipt.current_lane, 128),
            revision: text(receipt.settlement_authoritative_revision),
            execution_fingerprint: text(receipt.successor_execution_fingerprint, 128),
        },
        execution_precondition_verified: receipt.execution_precondition_verified === true,
    };
}
function projectVerification(verification) {
    const value = row(verification);
    return {
        predicate_key: text(value.predicate_key),
        source_ref: value.predicate_key ? `verification:${String(value.predicate_key)}` : null,
        work_ref: text(value.work_ref, 128),
        predicate_kind: text(value.predicate_kind, 128),
        status: 'verified',
        satisfied_at: time(value.satisfied_at),
        evidence_sha256: text(value.evidence_sha256, 128),
        evidence: boundedEvidenceProjection(value.evidence ?? {}),
    };
}
function projectRecovery(resolution) {
    const value = row(resolution);
    return {
        recovery_ref: value.resolution_id ? `resolution:${String(value.resolution_id)}` : null,
        invocation_id: text(value.invocation_id, 128),
        resolution_kind: text(value.resolution_kind, 64),
        created_at: time(value.created_at),
        evidence: boundedEvidenceProjection(value.evidence ?? {}),
    };
}
function workObservationFromLease(lease, role, receiptInput) {
    const value = row(lease);
    const receipt = row(receiptInput);
    if (!value.work_ref)
        return null;
    const state = role === 'claim' ? receipt.current_state ?? value.previous_state : receipt.current_state;
    const lane = role === 'claim' ? receipt.lane ?? value.previous_lane : receipt.current_lane;
    const revision = role === 'claim' ? receipt.authoritative_revision ?? value.claim_revision : receipt.settlement_authoritative_revision;
    const executionFingerprint = role === 'claim' ? receipt.execution_fingerprint ?? null : receipt.successor_execution_fingerprint ?? null;
    return {
        work_ref: text(value.work_ref, 128),
        authority: 'linear',
        revision: text(revision),
        execution_fingerprint: text(executionFingerprint, 128),
        state: text(state, 128),
        lane: text(lane, 128),
        repository: text(receipt.repository, 256),
        observation_role: role,
        source_ref: value.lease_id ? `lease:${String(value.lease_id)}:${role}` : null,
    };
}
function workObservationFromHorizon(horizon, candidateInput, index) {
    const candidate = row(candidateInput);
    if (!candidate.work_ref)
        return null;
    const positionValue = Number(candidate.position);
    const position = Number.isInteger(positionValue) ? positionValue : index + 1;
    const horizonId = field(horizon, 'horizon_id');
    return {
        work_ref: text(candidate.work_ref, 128),
        authority: 'linear',
        revision: text(candidate.authoritative_revision),
        execution_fingerprint: text(candidate.execution_fingerprint, 128),
        state: text(candidate.expected_state, 128),
        lane: text(candidate.expected_lane, 128),
        repository: text(candidate.repository, 256),
        observation_role: 'horizon',
        source_ref: horizonId ? `horizon:${String(horizonId)}:candidate:${position}` : null,
    };
}
function projectWorkObservations(horizons, leases) {
    const observations = [];
    for (const horizon of horizons) {
        array(field(horizon, 'candidates')).forEach((candidate, index) => {
            const observation = workObservationFromHorizon(horizon, candidate, index);
            if (observation)
                observations.push(observation);
        });
    }
    for (const lease of leases) {
        const claimReceipt = field(lease, 'claim_receipt');
        const settleReceipt = field(lease, 'settle_receipt');
        if (claimReceipt)
            observations.push(workObservationFromLease(lease, 'claim', claimReceipt));
        if (settleReceipt)
            observations.push(workObservationFromLease(lease, 'settlement', settleReceipt));
    }
    return observations.filter((value) => Boolean(value)).sort((left, right) => {
        const work = id(left.work_ref).localeCompare(id(right.work_ref));
        if (work)
            return work;
        const role = id(left.observation_role).localeCompare(id(right.observation_role));
        if (role)
            return role;
        return id(left.source_ref).localeCompare(id(right.source_ref));
    });
}
export function projectExecutionEvidence(source = {}) {
    const horizons = [...array(source.horizons)].sort(compareHorizons);
    const leases = [...array(source.leases)].sort(compareByTimeAndId('created_at', 'lease_id'));
    const checkpoints = [...array(source.checkpoints)].sort(compareByTimeAndId('created_at', 'checkpoint_id'));
    const invocations = [...array(source.invocations)].sort(compareInvocations);
    const resolutions = [...array(source.resolutions)].sort(compareByTimeAndId('created_at', 'resolution_id'));
    const verifications = [...array(source.verifications)].sort(compareByTimeAndId('satisfied_at', 'predicate_key'));
    return {
        schema: EXECUTION_EVIDENCE_SCHEMA,
        run: projectRun(source.run),
        target: projectTarget(source.run),
        work_observations: projectWorkObservations(horizons, leases),
        leases: leases.map(projectLease),
        checkpoints: checkpoints.map(projectCheckpoint),
        commands: invocations.map((invocation) => projectCommand(invocation, resolutions)),
        settlements: leases.map(projectSettlement).filter((value) => Boolean(value)),
        verifications: verifications.map(projectVerification),
        recoveries: resolutions.map(projectRecovery),
        integrity: { status: 'not_evaluated', violations: [] },
    };
}
export const executionEvidenceInternals = Object.freeze({
    NO_EXTERNAL_MUTATION_COMMANDS: new Set(NO_EXTERNAL_MUTATION_COMMANDS),
    VERIFIED_EXTERNAL_EFFECT_COMMANDS: new Set(VERIFIED_EXTERNAL_EFFECT_COMMANDS),
    compareInvocations,
    compareByTimeAndId,
    compareHorizons,
    commandSpecificEffectConfirmed,
});
