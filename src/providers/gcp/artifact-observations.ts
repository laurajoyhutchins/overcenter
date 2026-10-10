import { canonicalDigest } from '../../digest.ts';
import {
  observeProjectedCertifiedGcpRead200,
  type GcpObservationOperation,
} from './certified-observation.ts';
import { encodeGcpPathSegment, type GcpJsonGet } from './rest.ts';

export interface GcpArtifactReadOptions {
  get?: GcpJsonGet;
  clock?: () => string;
  quotaProject?: string;
}

export interface GcpArtifactEvidence {
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

export type CertifiedGcpArtifactRead<T> =
  | { state: 'observed'; value: T; evidence: GcpArtifactEvidence }
  | { state: 'indeterminate'; observation_error: string };

const buildSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    projectId: { type: 'string' },
    status: { type: 'string' },
    createTime: { type: 'string' },
    startTime: { type: 'string' },
    finishTime: { type: 'string' },
    results: {
      type: 'object',
      properties: {
        images: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              digest: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const;

const storageSchema = {
  type: 'object',
  properties: {
    bucket: { type: 'string' },
    name: { type: 'string' },
    generation: { type: 'string' },
    crc32c: { type: 'string' },
    size: { type: 'string' },
    metageneration: { type: 'string' },
  },
} as const;

const repositorySchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    format: { type: 'string' },
    createTime: { type: 'string' },
    updateTime: { type: 'string' },
  },
} as const;

export const GCP_CLOUD_BUILD_OPERATION: GcpObservationOperation = {
  provider: 'gcp',
  authority_host: 'cloudbuild.googleapis.com',
  api_version: 'v1',
  method: 'GET',
  path_template: '/v1/projects/{project}/locations/{location}/builds/{build}',
  operation_id: 'cloudbuild.projects.locations.builds.get',
  schema_sha256: canonicalDigest(buildSchema),
  outcomes: [{ status: '200', schema: buildSchema }],
};

export const GCP_STORAGE_OBJECT_OPERATION: GcpObservationOperation = {
  provider: 'gcp',
  authority_host: 'storage.googleapis.com',
  api_version: 'v1',
  method: 'GET',
  path_template: '/storage/v1/b/{bucket}/o/{object}',
  operation_id: 'storage.objects.get',
  schema_sha256: canonicalDigest(storageSchema),
  outcomes: [{ status: '200', schema: storageSchema }],
};

export const GCP_ARTIFACT_REPOSITORY_OPERATION: GcpObservationOperation = {
  provider: 'gcp',
  authority_host: 'artifactregistry.googleapis.com',
  api_version: 'v1',
  method: 'GET',
  path_template: '/v1/projects/{project}/locations/{location}/repositories/{repository}',
  operation_id: 'artifactregistry.projects.locations.repositories.get',
  schema_sha256: canonicalDigest(repositorySchema),
  outcomes: [{ status: '200', schema: repositorySchema }],
};

export interface CertifiedGcpBuild {
  id: string;
  projectId?: string;
  status: string;
  createTime?: string;
  startTime?: string;
  finishTime?: string;
  results?: { images?: Array<{ name?: string; digest?: string }> };
}

export interface CertifiedGcpStorageObject {
  bucket: string;
  name: string;
  generation: string;
  crc32c: string;
  size: string;
  metageneration?: string;
}

export interface CertifiedGcpArtifactRepository {
  name: string;
  format: string;
  createTime?: string;
  updateTime?: string;
}

const buildFields = [
  { path: 'id' },
  { path: 'projectId', required: false },
  { path: 'status' },
  { path: 'createTime', required: false },
  { path: 'startTime', required: false },
  { path: 'finishTime', required: false },
  { path: 'results.images[].name', required: false },
  { path: 'results.images[].digest', required: false },
] as const;

const objectFields = [
  { path: 'bucket' },
  { path: 'name' },
  { path: 'generation' },
  { path: 'crc32c' },
  { path: 'size' },
  { path: 'metageneration', required: false },
] as const;

const repositoryFields = [
  { path: 'name' },
  { path: 'format' },
  { path: 'createTime', required: false },
  { path: 'updateTime', required: false },
] as const;

function part(value: string): string {
  return encodeGcpPathSegment(value, 'GCP_ARTIFACT_COORDINATE_INVALID');
}

function validSegment(value: string): boolean {
  try {
    part(value);
    return true;
  } catch {
    return false;
  }
}

function read<T>(
  token: string,
  operation: GcpObservationOperation,
  requestPath: string,
  expectedName: string,
  fields: readonly { path: string; required?: boolean }[],
  options: GcpArtifactReadOptions,
  check: (value: T) => void,
): CertifiedGcpArtifactRead<T> {
  try {
    const result = observeProjectedCertifiedGcpRead200<T>({
      accessToken: token,
      operation,
      request: { path: requestPath, parameters: { name: expectedName } },
      fields,
      observerId: operation.operation_id,
      ...(options.get ? { get: options.get } : {}),
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.quotaProject ? { quotaProject: options.quotaProject } : {}),
    });
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
        requested_name: expectedName,
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

export function observeCertifiedGcpBuild(
  token: string,
  coordinate: { project: string; location: string; build: string },
  options: GcpArtifactReadOptions = {},
): CertifiedGcpArtifactRead<CertifiedGcpBuild> {
  if (![coordinate.project, coordinate.location, coordinate.build].every(validSegment)) {
    return { state: 'indeterminate', observation_error: 'GCP_ARTIFACT_COORDINATE_INVALID' };
  }
  const path =
    '/v1/projects/' +
    part(coordinate.project) +
    '/locations/' +
    part(coordinate.location) +
    '/builds/' +
    part(coordinate.build);
  return read(
    token,
    GCP_CLOUD_BUILD_OPERATION,
    path,
    coordinate.build,
    buildFields,
    options,
    (v) => {
      if (
        v.id !== coordinate.build ||
        (v.projectId !== undefined && v.projectId !== coordinate.project) ||
        ![
          'PENDING',
          'QUEUED',
          'WORKING',
          'SUCCESS',
          'FAILURE',
          'INTERNAL_ERROR',
          'TIMEOUT',
          'CANCELLED',
          'EXPIRED',
        ].includes(v.status)
      ) {
        throw new Error('GCP_BUILD_IDENTITY_OR_STATUS_INVALID');
      }
    },
  );
}

export function observeCertifiedGcpStorageObject(
  token: string,
  coordinate: { bucket: string; object: string },
  options: GcpArtifactReadOptions = {},
): CertifiedGcpArtifactRead<CertifiedGcpStorageObject> {
  // Cloud Storage keys may contain /, but invalid control bytes must
  // be rejected before contacting the provider.
  if (
    !validSegment(coordinate.bucket) ||
    !coordinate.object ||
    [...coordinate.object].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return { state: 'indeterminate', observation_error: 'GCP_STORAGE_OBJECT_COORDINATE_INVALID' };
  }
  // Encode the entire object key as one parameter, not a caller URL.
  const path =
    '/storage/v1/b/' + part(coordinate.bucket) + '/o/' + encodeURIComponent(coordinate.object);
  return read(
    token,
    GCP_STORAGE_OBJECT_OPERATION,
    path,
    coordinate.bucket + '/' + coordinate.object,
    objectFields,
    options,
    (v) => {
      if (
        v.bucket !== coordinate.bucket ||
        v.name !== coordinate.object ||
        !/^[1-9][0-9]*$/.test(v.generation) ||
        !/^(0|[1-9][0-9]*)$/.test(v.size) ||
        !/^[A-Za-z0-9+/]{6}==$/.test(v.crc32c)
      ) {
        throw new Error('GCP_STORAGE_OBJECT_IDENTITY_OR_METADATA_INVALID');
      }
    },
  );
}

export function observeCertifiedGcpArtifactRepository(
  token: string,
  coordinate: { project: string; location: string; repository: string },
  options: GcpArtifactReadOptions = {},
): CertifiedGcpArtifactRead<CertifiedGcpArtifactRepository> {
  if (![coordinate.project, coordinate.location, coordinate.repository].every(validSegment)) {
    return { state: 'indeterminate', observation_error: 'GCP_ARTIFACT_COORDINATE_INVALID' };
  }
  const name =
    'projects/' +
    coordinate.project +
    '/locations/' +
    coordinate.location +
    '/repositories/' +
    coordinate.repository;
  const path =
    '/v1/projects/' +
    part(coordinate.project) +
    '/locations/' +
    part(coordinate.location) +
    '/repositories/' +
    part(coordinate.repository);
  return read(
    token,
    GCP_ARTIFACT_REPOSITORY_OPERATION,
    path,
    name,
    repositoryFields,
    options,
    (v) => {
      if (
        v.name !== name ||
        !['DOCKER', 'MAVEN', 'NPM', 'APT', 'YUM', 'KFP', 'GO', 'PYTHON', 'GENERIC'].includes(
          v.format,
        )
      ) {
        throw new Error('GCP_ARTIFACT_REPOSITORY_IDENTITY_INVALID');
      }
    },
  );
}

/**
 * Pure settlement predicate. Success of the build alone is insufficient;
 * the provider must return a matching immutable output digest.
 */
export function assessGcpBuildImage(
  result: CertifiedGcpArtifactRead<CertifiedGcpBuild>,
  expectedImage: { name: string; digest: string },
): 'settled' | 'hold' {
  if (result.state !== 'observed' || result.value.status !== 'SUCCESS') return 'hold';
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedImage.digest)) return 'hold';
  const images = result.value.results?.images ?? [];
  return images.some(
    (image) => image.name === expectedImage.name && image.digest === expectedImage.digest,
  )
    ? 'settled'
    : 'hold';
}
