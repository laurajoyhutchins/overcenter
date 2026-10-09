import type { RunnerExecutionLease } from './gcp-runner-launcher.ts';

// Host-emitted diagnostics are not certified provider observations and cannot
// authorize settlement. In particular, an HTTP 200 from Pub/Sub acknowledge
// does not establish durable acknowledgement or prove that a lease is gone.
export const WARM_RUNNER_OPERATIONAL_EVENT_SCHEMA = 'overcenter-warm-runner-operational-event/v1';

export type WarmRunnerOperationalStage =
  | 'lease_received'
  | 'job_stale'
  | 'jit_authorized'
  | 'container_started'
  | 'container_exit_zero'
  | 'container_absent_readback'
  | 'workspace_absent_readback'
  | 'ack_request_accepted'
  | 'ack_request_uncertain'
  | 'execution_failed'
  | 'ack_extension_failed';

export interface WarmRunnerOperationalIdentity {
  project_id: string;
  subscription: string;
  repository: string;
  repository_id: number;
  owner_id: number;
  job_id: number;
  message_id: string;
  attempt_id: string;
}

export interface WarmRunnerOperationalEvent extends WarmRunnerOperationalIdentity {
  schema: typeof WARM_RUNNER_OPERATIONAL_EVENT_SCHEMA;
  event: 'warm_runner_operational_observation';
  stage: WarmRunnerOperationalStage;
  sequence: number;
  observed_at: string;
  diagnostic?: string;
}

export function warmRunnerOperationalIdentity(
  projectId: string,
  subscription: string,
  lease: RunnerExecutionLease,
  messageId: string,
  attemptId: string,
): WarmRunnerOperationalIdentity {
  return {
    project_id: projectId,
    subscription,
    repository: lease.repository,
    repository_id: lease.repository_id,
    owner_id: lease.owner_id,
    job_id: lease.job_id,
    message_id: messageId,
    attempt_id: attemptId,
  };
}

export function warmRunnerOperationalEvent(
  identity: WarmRunnerOperationalIdentity,
  sequence: number,
  stage: WarmRunnerOperationalStage,
  observedAt: string,
  diagnostic?: string,
): WarmRunnerOperationalEvent {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('WARM_RUNNER_EVENT_SEQUENCE_INVALID');
  }
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new Error('WARM_RUNNER_EVENT_TIME_INVALID');
  }
  return {
    schema: WARM_RUNNER_OPERATIONAL_EVENT_SCHEMA,
    event: 'warm_runner_operational_observation',
    ...identity,
    stage,
    sequence,
    observed_at: observedAt,
    ...(diagnostic === undefined ? {} : { diagnostic: diagnostic.slice(0, 300) }),
  };
}

export type WarmRunnerTraceAssessment =
  | { state: 'incomplete'; reason: string }
  | { state: 'contradictory'; reason: string }
  | { state: 'reported-cleanup-and-ack-request'; settlement_authoritative: false };

// This is a diagnostic projection over raw host logs, not an authenticated
// GCP/Cloud Logging readback. Duplicated identical log records are idempotent.
export function assessWarmRunnerOperationalTrace(
  expected: WarmRunnerOperationalIdentity,
  observations: readonly WarmRunnerOperationalEvent[],
): WarmRunnerTraceAssessment {
  if (observations.length === 0) {
    return { state: 'incomplete', reason: 'WARM_RUNNER_TRACE_MISSING' };
  }
  const records = new Map<number, WarmRunnerOperationalEvent>();
  for (const observation of observations) {
    if (
      observation.schema !== WARM_RUNNER_OPERATIONAL_EVENT_SCHEMA ||
      observation.event !== 'warm_runner_operational_observation' ||
      !Number.isSafeInteger(observation.sequence) ||
      observation.sequence < 1 ||
      !Number.isFinite(Date.parse(observation.observed_at)) ||
      (Object.keys(expected) as Array<keyof WarmRunnerOperationalIdentity>).some(
        (key) => observation[key] !== expected[key],
      )
    ) {
      return { state: 'contradictory', reason: 'WARM_RUNNER_TRACE_IDENTITY_OR_SHAPE_MISMATCH' };
    }
    const prior = records.get(observation.sequence);
    if (prior && JSON.stringify(prior) !== JSON.stringify(observation)) {
      return { state: 'contradictory', reason: 'WARM_RUNNER_TRACE_SEQUENCE_CONFLICT' };
    }
    records.set(observation.sequence, observation);
  }
  const ordered = [...records.values()].sort((a, b) => a.sequence - b.sequence);
  const received = ordered.find((item) => item.stage === 'lease_received');
  if (!received || received.sequence !== 1) {
    return { state: 'incomplete', reason: 'WARM_RUNNER_TRACE_LEASE_RECEIPT_MISSING' };
  }
  if (
    ordered.some((item, index) => item.sequence !== index + 1) ||
    ordered.some((item) =>
      ['execution_failed', 'ack_request_uncertain', 'ack_extension_failed'].includes(item.stage),
    )
  ) {
    return { state: 'incomplete', reason: 'WARM_RUNNER_TRACE_UNRESOLVED' };
  }
  const stages = ordered.map((item) => item.stage).join(',');
  const completedJob = [
    'lease_received',
    'jit_authorized',
    'container_started',
    'container_exit_zero',
    'container_absent_readback',
    'workspace_absent_readback',
    'ack_request_accepted',
  ].join(',');
  const staleJob = [
    'lease_received',
    'job_stale',
    'workspace_absent_readback',
    'ack_request_accepted',
  ].join(',');
  if (stages !== completedJob && stages !== staleJob) {
    return { state: 'incomplete', reason: 'WARM_RUNNER_TRACE_READBACK_INCOMPLETE' };
  }
  return {
    state: 'reported-cleanup-and-ack-request',
    settlement_authoritative: false,
  };
}
