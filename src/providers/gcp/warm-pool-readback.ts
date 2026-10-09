import {
  assessGcpWarmPool,
  observeCertifiedGcpZonalAutoscaler,
  observeCertifiedGcpZonalMig,
  type GcpComputeReadOptions,
} from './compute-zonal-runner-pool.ts';

export const GCP_WARM_POOL_READBACK_SCHEMA = 'overcenter-gcp-warm-pool-readback/v1' as const;

export interface GcpWarmPoolReadbackTarget {
  project: string;
  zone: string;
  mig: string;
  autoscaler: string;
  subscription: string;
  stabilization_seconds: number;
  source_sha: string;
}

export interface GcpWarmPoolReadbackReceipt {
  schema: typeof GCP_WARM_POOL_READBACK_SCHEMA;
  target: GcpWarmPoolReadbackTarget;
  observation: 'observed' | 'hold';
  reason: string | null;
  policy: 'matches' | 'drift' | 'unknown';
  capacity: 'target-zero-stable' | 'target-one-stable' | 'changing' | 'out-of-bounds' | 'unknown';
  observed_provider_ids: { mig: string | null; autoscaler: string | null };
  observed_at: { mig: string | null; autoscaler: string | null };
  actual_instances_verified_absent: false;
  pubsub_ack_verified: false;
  host_teardown_verified: false;
  effect_authorized: false;
}

function validSegment(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !/[/\\?#]/.test(value) &&
    [...value].every((character) => {
      const code = character.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
  );
}

function validTarget(target: GcpWarmPoolReadbackTarget): boolean {
  return (
    [target.project, target.zone, target.mig, target.autoscaler, target.subscription].every(
      validSegment,
    ) &&
    target.stabilization_seconds === 2700 &&
    /^[0-9a-f]{40}$/.test(target.source_sha)
  );
}

/**
 * An exact-source, read-only GCP status projection for use by a trusted
 * GitHub-hosted observer. This does not certify absence, Pub/Sub ACK,
 * or the cleanup of a GCE host.
 */
export function observeGcpWarmPoolReadback(
  accessToken: string,
  target: GcpWarmPoolReadbackTarget,
  options: GcpComputeReadOptions = {},
): GcpWarmPoolReadbackReceipt {
  if (!validTarget(target)) throw new Error('GCP_WARM_POOL_READBACK_TARGET_INVALID');
  if (!accessToken) throw new Error('GCP_WARM_POOL_READBACK_TOKEN_REQUIRED');

  const mig = observeCertifiedGcpZonalMig(
    accessToken,
    { project: target.project, zone: target.zone, mig: target.mig },
    options,
  );
  const autoscaler = observeCertifiedGcpZonalAutoscaler(
    accessToken,
    {
      project: target.project,
      zone: target.zone,
      mig: target.mig,
      autoscaler: target.autoscaler,
    },
    options,
  );
  const assessment = assessGcpWarmPool(mig, autoscaler, {
    subscription: target.subscription,
    stabilization_seconds: target.stabilization_seconds,
  });
  const observed = assessment.state === 'observed';
  const policy = observed ? assessment.policy : 'unknown';
  const capacity = observed ? assessment.capacity : 'unknown';
  return {
    schema: GCP_WARM_POOL_READBACK_SCHEMA,
    target: { ...target },
    observation: observed ? 'observed' : 'hold',
    reason: observed ? null : assessment.reason,
    policy,
    capacity,
    observed_provider_ids: {
      mig: mig.state === 'observed' ? mig.evidence.provider_id : null,
      autoscaler: autoscaler.state === 'observed' ? autoscaler.evidence.provider_id : null,
    },
    observed_at: {
      mig: mig.state === 'observed' ? mig.evidence.observed_at : null,
      autoscaler: autoscaler.state === 'observed' ? autoscaler.evidence.observed_at : null,
    },
    actual_instances_verified_absent: false,
    pubsub_ack_verified: false,
    host_teardown_verified: false,
    effect_authorized: false,
  };
}
