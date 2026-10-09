import { canonicalDigest } from '../../digest.ts';
import {
  observeProjectedCertifiedGcpRead200,
  type GcpObservationOperation,
} from './certified-observation.ts';
import { encodeGcpPathSegment, type GcpJsonGet } from './rest.ts';

const COMPUTE_AUTHORITY = 'compute.googleapis.com';

const ZONAL_MIG_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    zone: { type: 'string' },
    selfLink: { type: 'string' },
    instanceTemplate: { type: 'string' },
    targetSize: { type: 'integer' },
    fingerprint: { type: 'string' },
    status: {
      type: 'object',
      properties: {
        isStable: { type: 'boolean' },
        versionTarget: {
          type: 'object',
          properties: { isReached: { type: 'boolean' } },
        },
      },
    },
  },
} as const;

const ZONAL_AUTOSCALER_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string' },
    id: { type: 'string' },
    name: { type: 'string' },
    zone: { type: 'string' },
    selfLink: { type: 'string' },
    target: { type: 'string' },
    status: { type: 'string' },
    autoscalingPolicy: {
      type: 'object',
      properties: {
        minNumReplicas: { type: 'integer' },
        maxNumReplicas: { type: 'integer' },
        stabilizationPeriodSec: { type: 'integer' },
        coolDownPeriodSec: { type: 'integer' },
        mode: { type: 'string' },
        cpuUtilization: { type: 'object' },
        loadBalancingUtilization: { type: 'object' },
        scalingSchedules: { type: 'object' },
        customMetricUtilizations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              metric: { type: 'string' },
              filter: { type: 'string' },
              singleInstanceAssignment: { type: 'number' },
              utilizationTarget: { type: 'number' },
            },
          },
        },
      },
    },
  },
} as const;

export const GCP_ZONAL_MIG_SCHEMA_SHA256 = canonicalDigest(ZONAL_MIG_SCHEMA);
export const GCP_ZONAL_AUTOSCALER_SCHEMA_SHA256 = canonicalDigest(ZONAL_AUTOSCALER_SCHEMA);

export const GCP_ZONAL_MIG_OPERATION: GcpObservationOperation = {
  provider: 'gcp',
  authority_host: COMPUTE_AUTHORITY,
  api_version: 'v1',
  method: 'GET',
  path_template: '/compute/v1/projects/{project}/zones/{zone}/instanceGroupManagers/{instanceGroupManager}',
  operation_id: 'compute.instanceGroupManagers.get',
  schema_sha256: GCP_ZONAL_MIG_SCHEMA_SHA256,
  outcomes: [{ status: '200', schema: ZONAL_MIG_SCHEMA }],
};

export const GCP_ZONAL_AUTOSCALER_OPERATION: GcpObservationOperation = {
  provider: 'gcp',
  authority_host: COMPUTE_AUTHORITY,
  api_version: 'v1',
  method: 'GET',
  path_template: '/compute/v1/projects/{project}/zones/{zone}/autoscalers/{autoscaler}',
  operation_id: 'compute.autoscalers.get',
  schema_sha256: GCP_ZONAL_AUTOSCALER_SCHEMA_SHA256,
  outcomes: [{ status: '200', schema: ZONAL_AUTOSCALER_SCHEMA }],
};

const MIG_FIELDS = [
  { path: 'kind' },
  { path: 'id' },
  { path: 'name' },
  { path: 'zone' },
  { path: 'selfLink', required: false },
  { path: 'instanceTemplate', required: false },
  { path: 'targetSize' },
  { path: 'fingerprint', required: false },
  { path: 'status.isStable' },
  { path: 'status.versionTarget.isReached', required: false },
] as const;

const AUTOSCALER_FIELDS = [
  { path: 'kind' },
  { path: 'id' },
  { path: 'name' },
  { path: 'zone' },
  { path: 'selfLink', required: false },
  { path: 'target' },
  { path: 'status' },
  { path: 'autoscalingPolicy.minNumReplicas' },
  { path: 'autoscalingPolicy.maxNumReplicas' },
  { path: 'autoscalingPolicy.stabilizationPeriodSec' },
  { path: 'autoscalingPolicy.coolDownPeriodSec', required: false },
  { path: 'autoscalingPolicy.mode', required: false },
  { path: 'autoscalingPolicy.cpuUtilization', required: false },
  { path: 'autoscalingPolicy.loadBalancingUtilization', required: false },
  { path: 'autoscalingPolicy.scalingSchedules', required: false },
  { path: 'autoscalingPolicy.customMetricUtilizations[].metric', required: false },
  { path: 'autoscalingPolicy.customMetricUtilizations[].filter', required: false },
  { path: 'autoscalingPolicy.customMetricUtilizations[].singleInstanceAssignment', required: false },
  { path: 'autoscalingPolicy.customMetricUtilizations[].utilizationTarget', required: false },
] as const;

export interface GcpZonalCoordinate {
  project: string;
  zone: string;
}

export interface GcpZonalMigCoordinate extends GcpZonalCoordinate {
  mig: string;
}

export interface GcpZonalAutoscalerCoordinate extends GcpZonalCoordinate {
  autoscaler: string;
  mig: string;
}

export interface CertifiedGcpZonalMig {
  kind: string;
  id: string;
  name: string;
  zone: string;
  selfLink?: string;
  instanceTemplate?: string;
  targetSize: number;
  fingerprint?: string;
  status: {
    isStable: boolean;
    versionTarget?: { isReached: boolean };
  };
}

export interface CertifiedGcpZonalAutoscaler {
  kind: string;
  id: string;
  name: string;
  zone: string;
  selfLink?: string;
  target: string;
  status: string;
  autoscalingPolicy: {
    minNumReplicas: number;
    maxNumReplicas: number;
    stabilizationPeriodSec: number;
    coolDownPeriodSec?: number;
    mode?: string;
    cpuUtilization?: object;
    loadBalancingUtilization?: object;
    scalingSchedules?: object;
    customMetricUtilizations?: Array<{
      metric?: string;
      filter?: string;
      singleInstanceAssignment?: number;
      utilizationTarget?: number;
    }>;
  };
}

export interface CertifiedGcpComputeReadEvidence {
  provider: 'gcp';
  authority_host: typeof COMPUTE_AUTHORITY;
  operation_id: string;
  schema_sha256: string;
  observed_at: string;
  project: string;
  zone: string;
  name: string;
  provider_id: string;
  validated_paths: string[];
  optional_absent_paths: string[];
  negative_evidence_authoritative: false;
}

export type CertifiedGcpComputeRead<Value> =
  | { state: 'observed'; value: Value; evidence: CertifiedGcpComputeReadEvidence }
  | { state: 'indeterminate'; observation_error: string };

export interface GcpComputeReadOptions {
  get?: GcpJsonGet;
  clock?: () => string;
  quotaProject?: string;
}

const segment = (value: string, label: string): string =>
  encodeGcpPathSegment(value, `GCP_COMPUTE_${label}_INVALID`);

function zonalResource(coordinate: GcpZonalCoordinate, kind: string, name: string): string {
  return `/compute/v1/projects/${segment(coordinate.project, 'PROJECT')}/zones/${segment(coordinate.zone, 'ZONE')}/${kind}/${segment(name, 'NAME')}`;
}

function zonePath(coordinate: GcpZonalCoordinate): string {
  return `/compute/v1/projects/${segment(coordinate.project, 'PROJECT')}/zones/${segment(coordinate.zone, 'ZONE')}`;
}

// Only accepted Compute canonical URL forms can assert resource identity.
// In particular, an attacker-controlled origin ending in the same path is not sufficient.
function isExactComputeSelfLink(value: string, path: string): boolean {
  return (
    value === path ||
    value === `https://www.googleapis.com${path}` ||
    value === `https://compute.googleapis.com${path}`
  );
}

function readEvidence(
  value: { id: string },
  certified: { structural_validation: { validated_paths: string[]; optional_absent_paths: string[] } },
  operation: GcpObservationOperation,
  coordinate: GcpZonalCoordinate,
  name: string,
  observedAt: string,
): CertifiedGcpComputeReadEvidence {
  return {
    provider: 'gcp',
    authority_host: COMPUTE_AUTHORITY,
    operation_id: operation.operation_id,
    schema_sha256: operation.schema_sha256,
    observed_at: observedAt,
    project: coordinate.project,
    zone: coordinate.zone,
    name,
    provider_id: value.id,
    validated_paths: certified.structural_validation.validated_paths,
    optional_absent_paths: certified.structural_validation.optional_absent_paths,
    negative_evidence_authoritative: false,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function observeCertifiedGcpZonalMig(
  accessToken: string,
  coordinate: GcpZonalMigCoordinate,
  options: GcpComputeReadOptions = {},
): CertifiedGcpComputeRead<CertifiedGcpZonalMig> {
  try {
    const path = zonalResource(coordinate, 'instanceGroupManagers', coordinate.mig);
    const { value, certified, observed_at } =
      observeProjectedCertifiedGcpRead200<CertifiedGcpZonalMig>({
        accessToken,
        operation: GCP_ZONAL_MIG_OPERATION,
        request: {
          path,
          parameters: {
            project: coordinate.project,
            zone: coordinate.zone,
            instanceGroupManager: coordinate.mig,
          },
        },
        fields: MIG_FIELDS,
        observerId: 'compute-zonal-mig',
        ...(options.get ? { get: options.get } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.quotaProject ? { quotaProject: options.quotaProject } : {}),
      });
    if (
      value.kind !== 'compute#instanceGroupManager' ||
      value.name !== coordinate.mig ||
      !isExactComputeSelfLink(value.zone, zonePath(coordinate)) ||
      (value.selfLink !== undefined && !isExactComputeSelfLink(value.selfLink, path))
    ) {
      throw new Error('GCP_COMPUTE_MIG_COORDINATE_MISMATCH');
    }
    if (
      value.id.length === 0 ||
      !Number.isSafeInteger(value.targetSize) ||
      value.targetSize < 0 ||
      (value.fingerprint !== undefined && value.fingerprint.length === 0)
    ) {
      throw new Error('GCP_COMPUTE_MIG_STATE_INVALID');
    }
    return {
      state: 'observed',
      value,
      evidence: readEvidence(value, certified, GCP_ZONAL_MIG_OPERATION, coordinate, coordinate.mig, observed_at),
    };
  } catch (error: unknown) {
    return { state: 'indeterminate', observation_error: message(error) };
  }
}

export function observeCertifiedGcpZonalAutoscaler(
  accessToken: string,
  coordinate: GcpZonalAutoscalerCoordinate,
  options: GcpComputeReadOptions = {},
): CertifiedGcpComputeRead<CertifiedGcpZonalAutoscaler> {
  try {
    const path = zonalResource(coordinate, 'autoscalers', coordinate.autoscaler);
    const target = zonalResource(coordinate, 'instanceGroupManagers', coordinate.mig);
    const { value, certified, observed_at } =
      observeProjectedCertifiedGcpRead200<CertifiedGcpZonalAutoscaler>({
        accessToken,
        operation: GCP_ZONAL_AUTOSCALER_OPERATION,
        request: {
          path,
          parameters: {
            project: coordinate.project,
            zone: coordinate.zone,
            autoscaler: coordinate.autoscaler,
          },
        },
        fields: AUTOSCALER_FIELDS,
        observerId: 'compute-zonal-autoscaler',
        ...(options.get ? { get: options.get } : {}),
        ...(options.clock ? { clock: options.clock } : {}),
        ...(options.quotaProject ? { quotaProject: options.quotaProject } : {}),
      });
    if (
      value.kind !== 'compute#autoscaler' ||
      value.name !== coordinate.autoscaler ||
      !isExactComputeSelfLink(value.zone, zonePath(coordinate)) ||
      !isExactComputeSelfLink(value.target, target) ||
      (value.selfLink !== undefined && !isExactComputeSelfLink(value.selfLink, path))
    ) {
      throw new Error('GCP_COMPUTE_AUTOSCALER_COORDINATE_MISMATCH');
    }
    if (
      value.id.length === 0 ||
      !Number.isSafeInteger(value.autoscalingPolicy.minNumReplicas) ||
      !Number.isSafeInteger(value.autoscalingPolicy.maxNumReplicas) ||
      value.autoscalingPolicy.minNumReplicas < 0 ||
      value.autoscalingPolicy.maxNumReplicas < value.autoscalingPolicy.minNumReplicas ||
      value.autoscalingPolicy.stabilizationPeriodSec < 0
    ) {
      throw new Error('GCP_COMPUTE_AUTOSCALER_STATE_INVALID');
    }
    return {
      state: 'observed',
      value,
      evidence: readEvidence(
        value, certified, GCP_ZONAL_AUTOSCALER_OPERATION, coordinate, coordinate.autoscaler, observed_at,
      ),
    };
  } catch (error: unknown) {
    return { state: 'indeterminate', observation_error: message(error) };
  }
}

export interface GcpWarmPoolPolicy {
  subscription: string;
  stabilization_seconds: number;
}

export type GcpWarmPoolAssessment =
  | { state: 'indeterminate'; reason: string; actual_instances_verified_absent: false }
  | {
      state: 'observed';
      policy: 'matches' | 'drift';
      capacity: 'target-zero-stable' | 'target-one-stable' | 'changing' | 'out-of-bounds';
      actual_instances_verified_absent: false;
    };

// No GCP listManagedInstances, Pub/Sub or host evidence is available here.
// Even a stable targetSize=0 is NOT authoritative proof that all VMs are gone.
export function assessGcpWarmPool(
  mig: CertifiedGcpComputeRead<CertifiedGcpZonalMig>,
  autoscaler: CertifiedGcpComputeRead<CertifiedGcpZonalAutoscaler>,
  policy: GcpWarmPoolPolicy,
): GcpWarmPoolAssessment {
  if (mig.state !== 'observed' || autoscaler.state !== 'observed') {
    return {
      state: 'indeterminate',
      reason: mig.state === 'indeterminate' ? mig.observation_error : autoscaler.state === 'indeterminate' ? autoscaler.observation_error : 'GCP_READBACK_INCOMPLETE',
      actual_instances_verified_absent: false,
    };
  }
  if (
    mig.evidence.project !== autoscaler.evidence.project ||
    mig.evidence.zone !== autoscaler.evidence.zone ||
    !isExactComputeSelfLink(
      autoscaler.value.target,
      zonalResource(mig.evidence, 'instanceGroupManagers', mig.value.name),
    )
  ) {
    return {
      state: 'indeterminate',
      reason: 'GCP_WARM_POOL_OBSERVATION_COORDINATE_MISMATCH',
      actual_instances_verified_absent: false,
    };
  }
  const a = autoscaler.value.autoscalingPolicy;
  const metrics = a.customMetricUtilizations;
  const expectedFilter =
    `resource.type="pubsub_subscription" AND resource.labels.subscription_id="${policy.subscription}"`;
  const matches =
    autoscaler.value.status === 'ACTIVE' &&
    a.mode === 'ON' &&
    a.minNumReplicas === 0 &&
    a.maxNumReplicas === 1 &&
    a.stabilizationPeriodSec === policy.stabilization_seconds &&
    a.cpuUtilization === undefined &&
    a.loadBalancingUtilization === undefined &&
    a.scalingSchedules === undefined &&
    metrics?.length === 1 &&
    metrics[0]?.metric === 'pubsub.googleapis.com/subscription/num_undelivered_messages' &&
    metrics[0]?.filter === expectedFilter &&
    metrics[0]?.singleInstanceAssignment === 1 &&
    metrics[0]?.utilizationTarget === undefined;
  const capacity = !mig.value.status.isStable ||
      mig.value.status.versionTarget?.isReached !== true
    ? 'changing'
    : mig.value.targetSize === 0
      ? 'target-zero-stable'
      : mig.value.targetSize === 1
        ? 'target-one-stable'
        : 'out-of-bounds';
  return {
    state: 'observed',
    policy: matches ? 'matches' : 'drift',
    capacity,
    actual_instances_verified_absent: false,
  };
}
