import { canonicalDigest } from '../../digest.ts';
import type {
  CertifiedGcpCloudRunServiceResult,
  GcpCloudRunServiceCoordinate,
} from './cloud-run-service.ts';

/**
 * This is a pure, readback-bound change proposal. It is NOT an effect
 * dispatcher, reservation, IAM grant or authorization to deploy.
 */
export interface GcpCloudRunRevisionGoal {
  coordinate: GcpCloudRunServiceCoordinate;
  expected_uid: string;
  expected_etag: string;
  desired_revision: string;
}

export type GcpCloudRunChangePlan =
  | { state: 'hold'; reason: string; effect_authorized: false }
  | {
      state: 'converged';
      revision: string;
      observed_generation: string;
      effect_authorized: false;
    }
  | {
      state: 'requires-admission';
      target: string;
      observed_generation: string;
      expected_etag: string;
      proposal_sha256: string;
      effect_authorized: false;
    };

const coordinateSegment = (value: string): boolean => {
  if (!value || value === '.' || value === '..' || /[/\\?#]/.test(value)) return false;
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code > 0x1f && code !== 0x7f;
  });
};

function serviceName(coordinate: GcpCloudRunServiceCoordinate): string {
  return (
    'projects/' +
    coordinate.project +
    '/locations/' +
    coordinate.location +
    '/services/' +
    coordinate.service
  );
}

export function planGcpCloudRunRevision(
  goal: GcpCloudRunRevisionGoal,
  observed: CertifiedGcpCloudRunServiceResult,
): GcpCloudRunChangePlan {
  if (
    !coordinateSegment(goal.coordinate.project) ||
    !coordinateSegment(goal.coordinate.location) ||
    !coordinateSegment(goal.coordinate.service) ||
    !goal.expected_uid ||
    !goal.expected_etag ||
    !coordinateSegment(goal.desired_revision)
  ) {
    return { state: 'hold', reason: 'GCP_CLOUD_RUN_GOAL_INVALID', effect_authorized: false };
  }
  if (observed.state !== 'observed') {
    return {
      state: 'hold',
      reason: 'GCP_CLOUD_RUN_OBSERVATION_INDETERMINATE',
      effect_authorized: false,
    };
  }
  const target = serviceName(goal.coordinate);
  const value = observed.value;
  if (
    value.name !== target ||
    observed.evidence.requested_name !== target ||
    value.uid !== goal.expected_uid ||
    observed.evidence.uid !== goal.expected_uid ||
    value.etag !== goal.expected_etag
  ) {
    return { state: 'hold', reason: 'GCP_CLOUD_RUN_PRECONDITION_DRIFT', effect_authorized: false };
  }
  if (
    value.reconciling ||
    !value.observedGeneration ||
    value.observedGeneration !== value.generation
  ) {
    return { state: 'hold', reason: 'GCP_CLOUD_RUN_NOT_SETTLED', effect_authorized: false };
  }
  const revision = target + '/revisions/' + goal.desired_revision;
  if (
    value.latestReadyRevision === revision &&
    value.latestCreatedRevision === revision &&
    value.terminalCondition?.state === 'CONDITION_SUCCEEDED'
  ) {
    return {
      state: 'converged',
      revision,
      observed_generation: value.observedGeneration,
      effect_authorized: false,
    };
  }
  if (value.terminalCondition?.state === 'CONDITION_FAILED') {
    return { state: 'hold', reason: 'GCP_CLOUD_RUN_TERMINAL_FAILURE', effect_authorized: false };
  }
  return {
    state: 'requires-admission',
    target,
    observed_generation: value.observedGeneration,
    expected_etag: goal.expected_etag,
    proposal_sha256: canonicalDigest({
      operation: 'gcp.cloud-run-service/ensure-revision/v1',
      target,
      uid: goal.expected_uid,
      etag: goal.expected_etag,
      generation: value.generation,
      desired_revision: revision,
    }),
    effect_authorized: false,
  };
}
