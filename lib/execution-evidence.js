import { boundedEvidenceProjection, boundedEvidenceText } from './bounded-evidence.js';

export const EXECUTION_EVIDENCE_SCHEMA = 'execution-evidence-v1';

const NO_EXTERNAL_MUTATION_COMMANDS = new Set([
  'github.review_packet',
  'github.capabilities',
  'work.checkpoint',
  'work.heartbeat',
  'skill.activate',
  'skill.complete',
  'orchestration.start',
  'orchestration.horizon_checkpoint',
  'orchestration.horizon_resolve',
  'orchestration.finish',
  'orchestration.maintain',
  'orchestration.resume_packet',
  'orchestration.diagnose',
  'orchestration.status',
]);

const VERIFIED_EXTERNAL_EFFECT_COMMANDS = new Set([
  'github.repository_metadata.ensure',
  'github.repository_template.ensure',
  'github.repository_from_template.create',
  'github.milestone.ensure',
  'github.release.create',
  'github.required_checks.ensure',
]);

function array(value) { return Array.isArray(value) ? value : []; }
function text(value, max = 512) { return boundedEvidenceText(value, max); }
function time(value) { return value == null ? null : String(value); }
function id(value) { return value == null ? '' : String(value); }

function compareByTimeAndId(timeKey, idKey) {
  return (left, right) => {
    const leftTime = time(left?.[timeKey]) || '';
    const rightTime = time(right?.[timeKey]) || '';
    if (leftTime !== rightTime) return leftTime.localeCompare(rightTime);
    return id(left?.[idKey]).localeCompare(id(right?.[idKey]));
  };
}

function compareInvocations(left, right) {
  const a = Number(left?.sequence ?? Number.MAX_SAFE_INTEGER);
  const b = Number(right?.sequence ?? Number.MAX_SAFE_INTEGER);
  if (a !== b) return a - b;
  return id(left?.invocation_id).localeCompare(id(right?.invocation_id));
}

function compareHorizons(left, right) {
  const a = Number(left?.generation ?? Number.MAX_SAFE_INTEGER);
  const b = Number(right?.generation ?? Number.MAX_SAFE_INTEGER);
  if (a !== b) return a - b;
  return id(left?.horizon_id).localeCompare(id(right?.horizon_id));
}

function projectionObject(value) {
  const projected = boundedEvidenceProjection(value);
  return projected && typeof projected === 'object' && !Array.isArray(projected) ? projected : {};
}

function projectRun(run) {
  if (!run) return null;
  return {
    run_id: text(run.run_id),
    worker: text(run.worker, 256),
    mode: text(run.mode, 32),
    continuation_key: text(run.continuation_key),
    scope: projectionObject(run.scope),
    status: text(run.status, 64),
    disposition: text(run.disposition, 64),
    started_at: time(run.started_at),
    deadline_at: time(run.deadline_at),
    finished_at: time(run.finished_at),
    stop_reason: text(run.stop_reason, 2000),
    predecessor_run_id: text(run.predecessor_run_id),
  };
}

function projectTarget(run) {
  if (!run?.target || typeof run.target !== 'object' || Array.isArray(run.target)) return null;
  return {
    projection: projectionObject(run.target),
    target_sha256: text(run.target_sha256, 128),
    base_start_request_sha256: text(run.base_start_request_sha256, 128),
  };
}

function projectLease(lease) {
  return {
    lease_id: text(lease?.lease_id, 128),
    run_id: text(lease?.run_id),
    work_ref: text(lease?.work_ref, 128),
    gate: text(lease?.gate, 128),
    status: text(lease?.status, 64),
    created_at: time(lease?.created_at),
    expires_at: time(lease?.expires_at),
    settled_at: time(lease?.settled_at),
    previous_state: text(lease?.previous_state, 128),
    previous_lane: text(lease?.previous_lane, 128),
    claim_revision: text(lease?.claim_revision),
    active_revision: text(lease?.active_revision),
  };
}

function projectCheckpoint(checkpoint) {
  return {
    checkpoint_id: text(checkpoint?.checkpoint_id, 128),
    source_ref: checkpoint?.checkpoint_id ? `checkpoint:${checkpoint.checkpoint_id}` : null,
    lease_id: text(checkpoint?.lease_id, 128),
    checkpoint_sha256: text(checkpoint?.checkpoint_sha256, 128),
    created_at: time(checkpoint?.created_at),
    checkpoint: boundedEvidenceProjection(checkpoint?.checkpoint ?? {}),
  };
}

function matchingResolutions(invocation, resolutions) {
  return array(resolutions)
    .filter((resolution) => resolution?.invocation_id === invocation?.invocation_id)
    .sort(compareByTimeAndId('created_at', 'resolution_id'));
}

function commandSpecificEffectConfirmed(invocation) {
  if (invocation?.outcome !== 'succeeded') return false;
  const command = invocation?.command;
  const result = invocation?.result_projection && typeof invocation.result_projection === 'object' && !Array.isArray(invocation.result_projection)
    ? invocation.result_projection
    : {};
  if (VERIFIED_EXTERNAL_EFFECT_COMMANDS.has(command)) return result.verified === true;
  if (command === 'github.apply_changeset') return Boolean(result.commit_sha && result.new_head);
  if (command === 'work.claim') return Boolean(result.lease_id && result.authoritative_revision);
  if (command === 'work.settle') return Boolean(result.lease_id && result.settlement_authoritative_revision);
  if (command === 'github.integration.reconcile') return Boolean(result.merge_commit_sha);
  if (command === 'linear.archive') return result.archived === true || result.alreadyArchived === true;
  return false;
}

export function deriveMutationCertainty(invocation, resolutions = []) {
  if (NO_EXTERNAL_MUTATION_COMMANDS.has(invocation?.command)) return 'not_applicable';
  const matching = matchingResolutions(invocation, resolutions);
  if (matching.some((resolution) => resolution.resolution_kind === 'externally_confirmed')) return 'confirmed_present';
  if (matching.some((resolution) => resolution.resolution_kind === 'definitively_not_applied')) return 'definitively_absent';
  if (invocation?.may_have_mutated === false) return 'definitively_absent';
  if (commandSpecificEffectConfirmed(invocation)) return 'confirmed_present';
  if (invocation?.outcome === 'indeterminate' || invocation?.may_have_mutated === true) return 'unknown';
  return 'unknown';
}

function projectCommand(invocation, resolutions) {
  const matching = matchingResolutions(invocation, resolutions);
  return {
    invocation_id: text(invocation?.invocation_id, 128),
    source_ref: invocation?.invocation_id ? `invocation:${invocation.invocation_id}` : null,
    sequence: invocation?.sequence == null ? null : Number(invocation.sequence),
    command: text(invocation?.command, 128),
    target: {
      kind: text(invocation?.target_kind, 128),
      ref: text(invocation?.target_ref),
    },
    started_at: time(invocation?.started_at),
    completed_at: time(invocation?.completed_at),
    outcome: text(invocation?.outcome, 64),
    error: {
      code: text(invocation?.error_code, 128),
      class: text(invocation?.error_class, 128),
      retryable: typeof invocation?.retryable === 'boolean' ? invocation.retryable : null,
      rejection: typeof invocation?.rejection === 'boolean' ? invocation.rejection : null,
    },
    may_have_mutated: typeof invocation?.may_have_mutated === 'boolean' ? invocation.may_have_mutated : null,
    request_sha256: text(invocation?.request_sha256, 128),
    result_sha256: text(invocation?.result_sha256, 128),
    request: boundedEvidenceProjection(invocation?.request_projection ?? {}),
    result: boundedEvidenceProjection(invocation?.result_projection ?? {}),
    effect: { mutation_certainty: deriveMutationCertainty(invocation, matching) },
    resolution_refs: matching.map((resolution) => resolution?.resolution_id ? `resolution:${resolution.resolution_id}` : null).filter(Boolean),
  };
}

function settlementEvidenceRefs(plan) {
  const source = array(plan?.evidence).length ? array(plan.evidence) : array(plan?.replay_request?.evidence);
  return source.slice(0, 25).map((item) => {
    const kind = text(item?.kind, 128);
    const ref = text(item?.ref, 1000);
    return kind && ref ? { kind, ref } : null;
  }).filter(Boolean);
}

function projectSettlement(lease) {
  const receipt = lease?.settle_receipt && typeof lease.settle_receipt === 'object' && !Array.isArray(lease.settle_receipt) ? lease.settle_receipt : null;
  if (!receipt) return null;
  return {
    lease_id: text(lease?.lease_id, 128),
    source_ref: lease?.lease_id ? `lease:${lease.lease_id}:settlement` : null,
    work_ref: text(lease?.work_ref, 128),
    gate: text(lease?.gate, 128),
    settlement_disposition: text(receipt.disposition, 64),
    settled_at: time(lease?.settled_at ?? receipt.settled_at),
    evidence_refs: settlementEvidenceRefs(lease?.settle_plan),
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
  return {
    predicate_key: text(verification?.predicate_key),
    source_ref: verification?.predicate_key ? `verification:${verification.predicate_key}` : null,
    work_ref: text(verification?.work_ref, 128),
    predicate_kind: text(verification?.predicate_kind, 128),
    status: 'verified',
    satisfied_at: time(verification?.satisfied_at),
    evidence_sha256: text(verification?.evidence_sha256, 128),
    evidence: boundedEvidenceProjection(verification?.evidence ?? {}),
  };
}

function projectRecovery(resolution) {
  return {
    recovery_ref: resolution?.resolution_id ? `resolution:${resolution.resolution_id}` : null,
    invocation_id: text(resolution?.invocation_id, 128),
    resolution_kind: text(resolution?.resolution_kind, 64),
    created_at: time(resolution?.created_at),
    evidence: boundedEvidenceProjection(resolution?.evidence ?? {}),
  };
}

function workObservationFromLease(lease, role, receipt) {
  if (!lease?.work_ref) return null;
  const state = role === 'claim' ? receipt?.current_state ?? lease?.previous_state : receipt?.current_state;
  const lane = role === 'claim' ? receipt?.lane ?? lease?.previous_lane : receipt?.current_lane;
  const revision = role === 'claim' ? receipt?.authoritative_revision ?? lease?.claim_revision : receipt?.settlement_authoritative_revision;
  const executionFingerprint = role === 'claim' ? receipt?.execution_fingerprint ?? null : receipt?.successor_execution_fingerprint ?? null;
  return {
    work_ref: text(lease.work_ref, 128),
    authority: 'linear',
    revision: text(revision),
    execution_fingerprint: text(executionFingerprint, 128),
    state: text(state, 128),
    lane: text(lane, 128),
    repository: text(receipt?.repository, 256),
    observation_role: role,
    source_ref: lease?.lease_id ? `lease:${lease.lease_id}:${role}` : null,
  };
}

function workObservationFromHorizon(horizon, candidate, index) {
  if (!candidate?.work_ref) return null;
  const position = Number.isInteger(Number(candidate.position)) ? Number(candidate.position) : index + 1;
  return {
    work_ref: text(candidate.work_ref, 128),
    authority: 'linear',
    revision: text(candidate.authoritative_revision),
    execution_fingerprint: text(candidate.execution_fingerprint, 128),
    state: text(candidate.expected_state, 128),
    lane: text(candidate.expected_lane, 128),
    repository: text(candidate.repository, 256),
    observation_role: 'horizon',
    source_ref: horizon?.horizon_id ? `horizon:${horizon.horizon_id}:candidate:${position}` : null,
  };
}

function projectWorkObservations(horizons, leases) {
  const observations = [];
  for (const horizon of horizons) {
    array(horizon?.candidates).forEach((candidate, index) => {
      const observation = workObservationFromHorizon(horizon, candidate, index);
      if (observation) observations.push(observation);
    });
  }
  for (const lease of leases) {
    if (lease?.claim_receipt) observations.push(workObservationFromLease(lease, 'claim', lease.claim_receipt));
    if (lease?.settle_receipt) observations.push(workObservationFromLease(lease, 'settlement', lease.settle_receipt));
  }
  return observations.filter(Boolean).sort((left, right) => {
    const work = id(left.work_ref).localeCompare(id(right.work_ref));
    if (work) return work;
    const role = id(left.observation_role).localeCompare(id(right.observation_role));
    if (role) return role;
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
    settlements: leases.map(projectSettlement).filter(Boolean),
    verifications: verifications.map(projectVerification),
    recoveries: resolutions.map(projectRecovery),
    integrity: { status: 'not_evaluated', violations: [] },
  };
}

export const executionEvidenceInternals = Object.freeze({
  NO_EXTERNAL_MUTATION_COMMANDS,
  VERIFIED_EXTERNAL_EFFECT_COMMANDS,
  compareInvocations,
  compareByTimeAndId,
  compareHorizons,
  commandSpecificEffectConfirmed,
});
