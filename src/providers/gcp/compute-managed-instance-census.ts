import { readJsonWithCurl } from '../curl-json.ts';
import { canonicalDigest } from '../../digest.ts';
import { projectResponseSlice, validateResponseSlice } from '../../observation/response-slice.ts';
import { encodeGcpPathSegment } from './rest.ts';

const HOST = 'compute.googleapis.com' as const;
const schema = {
  type: 'object',
  properties: {
    managedInstances: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          instance: { type: 'string' },
          id: { type: 'string' },
          instanceStatus: { type: 'string' },
          currentAction: { type: 'string' },
        },
      },
    },
    nextPageToken: { type: 'string' },
  },
} as const;
const OPERATION_ID = 'compute.instanceGroupManagers.listManagedInstances' as const;
const SCHEMA_SHA256 = canonicalDigest(schema);
const fields = [
  { path: 'managedInstances[].instance' },
  { path: 'managedInstances[].id', required: false },
  { path: 'managedInstances[].instanceStatus', required: false },
  { path: 'managedInstances[].currentAction', required: false },
  { path: 'nextPageToken', required: false },
] as const;
const operation = {
  operation_id: OPERATION_ID,
  outcomes: [{ status: '200', schema }],
};

export interface GcpManagedInstanceCensusTarget {
  project: string;
  zone: string;
  mig: string;
}

export interface GcpManagedInstancePostRequest {
  authority_host: typeof HOST;
  method: 'POST';
  path: string;
  body: null;
}

export type GcpManagedInstancePost = (
  accessToken: string,
  request: GcpManagedInstancePostRequest,
) => unknown;

export interface GcpManagedInstanceCensusEvidence {
  provider: 'gcp';
  operation_id: typeof OPERATION_ID;
  schema_sha256: string;
  observed_at: string;
  target: GcpManagedInstanceCensusTarget;
  complete_single_page: true;
  managed_instance_count: number;
  zero_managed_membership_observed: boolean;
  // Listing alone does not prove process teardown or a durable Pub/Sub ACK.
  physical_zero_settled: false;
  negative_evidence_authoritative: false;
}

export type GcpManagedInstanceCensus =
  | {
      state: 'observed';
      instances: readonly {
        instance: string;
        id?: string;
        instanceStatus?: string;
        currentAction?: string;
      }[];
      evidence: GcpManagedInstanceCensusEvidence;
    }
  | { state: 'indeterminate'; observation_error: string };

export function postReadOnlyManagedInstances(
  accessToken: string,
  request: GcpManagedInstancePostRequest,
): unknown {
  if (
    !accessToken ||
    [...accessToken].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f || character === '"';
    }) ||
    request.authority_host !== HOST ||
    request.method !== 'POST' ||
    request.body !== null ||
    !/^\/compute\/v1\/projects\/[A-Za-z0-9_.-]+\/zones\/[A-Za-z0-9_.-]+\/instanceGroupManagers\/[A-Za-z0-9_.-]+\/listManagedInstances$/.test(
      request.path,
    )
  ) {
    throw new Error('GCP_MANAGED_INSTANCE_POST_UNAUTHORIZED_SHAPE');
  }
  // A POST with no body is the documented read-only Compute listManagedInstances
  // operation. The host, path and method are not caller-selectable.
  const config = `request = "POST"\nheader = "Authorization: Bearer ${accessToken}"\nheader = "Accept: application/json"\n`;
  return readJsonWithCurl(
    `https://${HOST}${request.path}`,
    config,
    'GCP_MANAGED_INSTANCE_READ_FAILED',
  );
}

function validPart(value: string): boolean {
  try {
    encodeGcpPathSegment(value, 'GCP_MANAGED_INSTANCE_COORDINATE_INVALID');
    return true;
  } catch {
    return false;
  }
}

function sameInstanceZone(value: string, target: GcpManagedInstanceCensusTarget): boolean {
  const suffix = `/compute/v1/projects/${target.project}/zones/${target.zone}/instances/`;
  return [`https://www.googleapis.com${suffix}`, `https://compute.googleapis.com${suffix}`].some(
    (prefix) => value.startsWith(prefix) && validPart(value.slice(prefix.length)),
  );
}

/**
 * Read-only POST mandated by the Compute API, not a generic GCP effect.
 * A paginated, missing or malformed result is not treated as absence.
 */
export function observeGcpManagedInstanceCensus(
  token: string,
  target: GcpManagedInstanceCensusTarget,
  options: { post?: GcpManagedInstancePost; clock?: () => string } = {},
): GcpManagedInstanceCensus {
  try {
    if (![target.project, target.zone, target.mig].every(validPart)) {
      throw new Error('GCP_MANAGED_INSTANCE_COORDINATE_INVALID');
    }
    const path =
      `/compute/v1/projects/${encodeURIComponent(target.project)}/zones/${encodeURIComponent(target.zone)}` +
      `/instanceGroupManagers/${encodeURIComponent(target.mig)}/listManagedInstances`;
    const response = (options.post ?? postReadOnlyManagedInstances)(token, {
      authority_host: HOST,
      method: 'POST',
      path,
      body: null,
    });
    validateResponseSlice(operation, '200', response, fields);
    const result = projectResponseSlice(response, fields) as {
      managedInstances?: Array<{
        instance: string;
        id?: string;
        instanceStatus?: string;
        currentAction?: string;
      }>;
      nextPageToken?: string;
    };
    if (!Array.isArray(result.managedInstances)) {
      throw new Error('GCP_MANAGED_INSTANCE_LIST_INCOMPLETE');
    }
    if (result.nextPageToken) throw new Error('GCP_MANAGED_INSTANCE_PAGINATION_REQUIRED');
    for (const item of result.managedInstances) {
      if (!sameInstanceZone(item.instance, target)) {
        throw new Error('GCP_MANAGED_INSTANCE_IDENTITY_MISMATCH');
      }
    }
    return {
      state: 'observed',
      instances: Object.freeze(result.managedInstances.map((member) => Object.freeze(member))),
      evidence: {
        provider: 'gcp',
        operation_id: OPERATION_ID,
        schema_sha256: SCHEMA_SHA256,
        observed_at: (options.clock ?? (() => new Date().toISOString()))(),
        target: { ...target },
        complete_single_page: true,
        managed_instance_count: result.managedInstances.length,
        zero_managed_membership_observed: result.managedInstances.length === 0,
        physical_zero_settled: false,
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
