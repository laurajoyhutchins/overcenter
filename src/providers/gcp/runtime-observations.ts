import { canonicalDigest } from '../../digest.ts';
import {
  observeProjectedCertifiedGcpRead200,
  type GcpObservationOperation,
} from './certified-observation.ts';
import { encodeGcpPathSegment, type GcpJsonGet } from './rest.ts';

export interface GcpRuntimeReadOptions {
  get?: GcpJsonGet;
  clock?: () => string;
  quotaProject?: string;
}

export interface GcpRuntimeEvidence {
  provider: 'gcp';
  operation_id: string;
  authority_host: string;
  schema_sha256: string;
  observed_at: string;
  requested_name: string;
  validated_paths: string[];
  optional_absent_paths: string[];
  negative_evidence_authoritative: false;
}

export type CertifiedGcpRuntimeRead<T> =
  | { state: 'observed'; value: T; evidence: GcpRuntimeEvidence }
  | { state: 'indeterminate'; observation_error: string };

const subscriptionSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    topic: { type: 'string' },
    ackDeadlineSeconds: { type: 'integer' },
    state: { type: 'string' },
    messageRetentionDuration: { type: 'string' },
  },
} as const;

const schedulerSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    state: { type: 'string' },
    schedule: { type: 'string' },
    timeZone: { type: 'string' },
    scheduleTime: { type: 'string' },
    lastAttemptTime: { type: 'string' },
  },
} as const;

const revisionSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    uid: { type: 'string' },
    service: { type: 'string' },
    generation: { type: 'string' },
    reconciling: { type: 'boolean' },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
  },
} as const;

export const GCP_PUBSUB_SUBSCRIPTION_OPERATION: GcpObservationOperation = {
  provider: 'gcp',
  authority_host: 'pubsub.googleapis.com',
  api_version: 'v1',
  method: 'GET',
  path_template: '/v1/projects/{project}/subscriptions/{subscription}',
  operation_id: 'pubsub.projects.subscriptions.get',
  schema_sha256: canonicalDigest(subscriptionSchema),
  outcomes: [{ status: '200', schema: subscriptionSchema }],
};

export const GCP_SCHEDULER_JOB_OPERATION: GcpObservationOperation = {
  provider: 'gcp',
  authority_host: 'cloudscheduler.googleapis.com',
  api_version: 'v1',
  method: 'GET',
  path_template: '/v1/projects/{project}/locations/{location}/jobs/{job}',
  operation_id: 'cloudscheduler.projects.locations.jobs.get',
  schema_sha256: canonicalDigest(schedulerSchema),
  outcomes: [{ status: '200', schema: schedulerSchema }],
};

export const GCP_CLOUD_RUN_REVISION_OPERATION: GcpObservationOperation = {
  provider: 'gcp',
  authority_host: 'run.googleapis.com',
  api_version: 'v2',
  method: 'GET',
  path_template:
    '/v2/projects/{project}/locations/{location}/services/{service}/revisions/{revision}',
  operation_id: 'run.projects.locations.services.revisions.get',
  schema_sha256: canonicalDigest(revisionSchema),
  outcomes: [{ status: '200', schema: revisionSchema }],
};

export interface CertifiedGcpSubscription {
  name: string;
  topic: string;
  ackDeadlineSeconds?: number;
  state?: string;
  messageRetentionDuration?: string;
}

export interface CertifiedGcpSchedulerJob {
  name: string;
  state: string;
  schedule?: string;
  timeZone?: string;
  scheduleTime?: string;
  lastAttemptTime?: string;
}

export interface CertifiedGcpCloudRunRevision {
  name: string;
  uid: string;
  service: string;
  generation?: string;
  reconciling?: boolean;
  conditions?: Array<{ type?: string; state?: string }>;
}

const subscriptionFields = [
  { path: 'name' },
  { path: 'topic' },
  { path: 'ackDeadlineSeconds', required: false },
  { path: 'state', required: false },
  { path: 'messageRetentionDuration', required: false },
] as const;

const schedulerFields = [
  { path: 'name' },
  { path: 'state' },
  { path: 'schedule', required: false },
  { path: 'timeZone', required: false },
  { path: 'scheduleTime', required: false },
  { path: 'lastAttemptTime', required: false },
] as const;

const revisionFields = [
  { path: 'name' },
  { path: 'uid' },
  { path: 'service' },
  { path: 'generation', required: false },
  { path: 'reconciling', required: false },
  { path: 'conditions[].type', required: false },
  { path: 'conditions[].state', required: false },
] as const;

function segment(value: string): string {
  return encodeGcpPathSegment(value, 'GCP_RUNTIME_COORDINATE_INVALID');
}

function validCoordinate(values: readonly string[]): boolean {
  try {
    values.forEach(segment);
    return true;
  } catch {
    return false;
  }
}

function observe<T extends { name: string }>(
  token: string,
  operation: GcpObservationOperation,
  name: string,
  fields: readonly { path: string; required?: boolean }[],
  options: GcpRuntimeReadOptions,
  check: (value: T) => void,
): CertifiedGcpRuntimeRead<T> {
  try {
    const path = '/' + operation.api_version + '/' + name.split('/').map(segment).join('/');
    const result = observeProjectedCertifiedGcpRead200<T>({
      accessToken: token,
      operation,
      request: { path, parameters: { name } },
      fields,
      observerId: operation.operation_id,
      ...(options.get ? { get: options.get } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.quotaProject ? { quotaProject: options.quotaProject } : {}),
    });
    if (result.value.name !== name) {
      throw new Error('GCP_RUNTIME_RESOURCE_IDENTITY_MISMATCH');
    }
    check(result.value);
    return {
      state: 'observed',
      value: result.value,
      evidence: {
        provider: 'gcp',
        operation_id: operation.operation_id,
        authority_host: operation.authority_host,
        schema_sha256: operation.schema_sha256,
        observed_at: result.observed_at,
        requested_name: name,
        validated_paths: result.certified.structural_validation.validated_paths,
        optional_absent_paths: result.certified.structural_validation.optional_absent_paths,
        negative_evidence_authoritative: false,
      },
    };
  } catch (error: unknown) {
    return {
      state: 'indeterminate',
      observation_error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function observeCertifiedGcpSubscription(
  token: string,
  coordinate: { project: string; subscription: string },
  options: GcpRuntimeReadOptions = {},
): CertifiedGcpRuntimeRead<CertifiedGcpSubscription> {
  if (!validCoordinate([coordinate.project, coordinate.subscription])) {
    return { state: 'indeterminate', observation_error: 'GCP_RUNTIME_COORDINATE_INVALID' };
  }
  const name = 'projects/' + coordinate.project + '/subscriptions/' + coordinate.subscription;
  return observe(
    token,
    GCP_PUBSUB_SUBSCRIPTION_OPERATION,
    name,
    subscriptionFields,
    options,
    (v) => {
      if (
        !v.topic.startsWith('projects/') ||
        v.topic.split('/').length !== 4 ||
        v.topic.split('/')[2] !== 'topics' ||
        (v.ackDeadlineSeconds !== undefined &&
          (v.ackDeadlineSeconds < 10 || v.ackDeadlineSeconds > 600))
      ) {
        throw new Error('GCP_PUBSUB_SUBSCRIPTION_STATE_INVALID');
      }
    },
  );
}

export function observeCertifiedGcpSchedulerJob(
  token: string,
  coordinate: { project: string; location: string; job: string },
  options: GcpRuntimeReadOptions = {},
): CertifiedGcpRuntimeRead<CertifiedGcpSchedulerJob> {
  if (!validCoordinate([coordinate.project, coordinate.location, coordinate.job])) {
    return { state: 'indeterminate', observation_error: 'GCP_RUNTIME_COORDINATE_INVALID' };
  }
  const name =
    'projects/' +
    coordinate.project +
    '/locations/' +
    coordinate.location +
    '/jobs/' +
    coordinate.job;
  return observe(token, GCP_SCHEDULER_JOB_OPERATION, name, schedulerFields, options, (v) => {
    if (!['ENABLED', 'PAUSED', 'DISABLED', 'UPDATE_FAILED'].includes(v.state)) {
      throw new Error('GCP_SCHEDULER_JOB_STATE_INVALID');
    }
  });
}

export function observeCertifiedGcpCloudRunRevision(
  token: string,
  coordinate: { project: string; location: string; service: string; revision: string },
  options: GcpRuntimeReadOptions = {},
): CertifiedGcpRuntimeRead<CertifiedGcpCloudRunRevision> {
  if (
    !validCoordinate([
      coordinate.project,
      coordinate.location,
      coordinate.service,
      coordinate.revision,
    ])
  ) {
    return { state: 'indeterminate', observation_error: 'GCP_RUNTIME_COORDINATE_INVALID' };
  }
  const service =
    'projects/' +
    coordinate.project +
    '/locations/' +
    coordinate.location +
    '/services/' +
    coordinate.service;
  const name = service + '/revisions/' + coordinate.revision;
  return observe(token, GCP_CLOUD_RUN_REVISION_OPERATION, name, revisionFields, options, (v) => {
    if (v.uid.length === 0 || v.service !== service) {
      throw new Error('GCP_CLOUD_RUN_REVISION_IDENTITY_INVALID');
    }
  });
}
