/**
 * Closed Policy Troubleshooter probe plan for the warm-pool observer.
 *
 * This is a pure diagnostic; it neither authenticates nor sends requests.
 * v3beta evaluates allow, deny and PAB for the specified principal, but a
 * finite sample can never establish the entire IAM permission ceiling.
 */
const PROJECT = 'project-6b810532-a302-48dc-b56';
const PRINCIPAL = 'overcenter-observer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com';
const MIG =
  '//compute.googleapis.com/projects/project-6b810532-a302-48dc-b56/zones/us-west1-a/instanceGroupManagers/overcenter-gce-runners';
const AUTOSCALER =
  '//compute.googleapis.com/projects/project-6b810532-a302-48dc-b56/zones/us-west1-a/autoscalers/overcenter-gce-runners-g2ow';

export const GCP_OBSERVER_TROUBLESHOOTER_ENDPOINT = Object.freeze({
  authority_host: 'policytroubleshooter.googleapis.com',
  method: 'POST',
  path: '/v3beta/iam:troubleshoot',
  mutation_authorized: false,
} as const);

interface AccessTuple {
  readonly principal: string;
  readonly fullResourceName: string;
  readonly permission: string;
}

export interface GcpObserverAccessProbe {
  readonly id: string;
  readonly accessTuple: AccessTuple;
  readonly expected_state: 'CAN_ACCESS' | 'CANNOT_ACCESS';
}

const definitions = [
  {
    id: 'mig-read',
    resource: MIG,
    permission: 'compute.instanceGroupManagers.get',
    expected: 'CAN_ACCESS',
  },
  {
    id: 'autoscaler-read',
    resource: AUTOSCALER,
    permission: 'compute.autoscalers.get',
    expected: 'CAN_ACCESS',
  },
  {
    id: 'mig-resize-denied',
    resource: MIG,
    permission: 'compute.instanceGroupManagers.update',
    expected: 'CANNOT_ACCESS',
  },
  {
    id: 'autoscaler-update-denied',
    resource: AUTOSCALER,
    permission: 'compute.autoscalers.update',
    expected: 'CANNOT_ACCESS',
  },
] as const;

export const GCP_OBSERVER_ACCESS_PROBES: readonly GcpObserverAccessProbe[] = Object.freeze(
  definitions.map((definition) =>
    Object.freeze({
      id: definition.id,
      accessTuple: Object.freeze({
        principal: PRINCIPAL,
        fullResourceName: definition.resource,
        permission: definition.permission,
      }),
      expected_state: definition.expected,
    }),
  ),
);

export interface GcpObserverAccessResult {
  readonly id: string;
  readonly evidence_ref: string;
  readonly response: unknown;
}

export interface GcpObserverAccessAssessment {
  readonly project: typeof PROJECT;
  readonly state: 'hold' | 'review_required' | 'sample_matches';
  readonly findings: readonly { id: string; finding: string }[];
  readonly authorization_granted: false;
  readonly full_permission_ceiling_verified: false;
  readonly live_resource_readback_established: false;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Evaluate externally retrieved responses. Exact tuple identity is mandatory.
 * UNKNOWN_INFO, UNKNOWN_CONDITIONAL, absent or malformed evidence => HOLD.
 * Even a matching sample never proves full IAM safety or live API success.
 */
export function assessGcpObserverAccess(
  responses: readonly GcpObserverAccessResult[],
): GcpObserverAccessAssessment {
  const seen = new Map<string, GcpObserverAccessResult>();
  const findings: { id: string; finding: string }[] = [];
  const known = new Set(GCP_OBSERVER_ACCESS_PROBES.map((probe) => probe.id));
  for (const response of responses) {
    if (!known.has(response.id) || seen.has(response.id)) {
      findings.push({ id: response.id, finding: 'UNEXPECTED_OR_DUPLICATE_PROBE' });
      continue;
    }
    seen.set(response.id, response);
  }
  let hold = findings.length > 0;
  let review = false;
  for (const probe of GCP_OBSERVER_ACCESS_PROBES) {
    const observation = seen.get(probe.id);
    if (!observation || !/^[a-zA-Z0-9_./:#-]+$/.test(observation.evidence_ref)) {
      findings.push({ id: probe.id, finding: 'MISSING_EVIDENCE' });
      hold = true;
      continue;
    }
    const result = observation.response;
    if (!object(result) || !object(result.accessTuple)) {
      findings.push({ id: probe.id, finding: 'INVALID_RESPONSE' });
      hold = true;
      continue;
    }
    const tuple = result.accessTuple;
    if (
      tuple.principal !== probe.accessTuple.principal ||
      tuple.fullResourceName !== probe.accessTuple.fullResourceName ||
      tuple.permission !== probe.accessTuple.permission
    ) {
      findings.push({ id: probe.id, finding: 'TUPLE_IDENTITY_MISMATCH' });
      hold = true;
      continue;
    }
    if (!['CAN_ACCESS', 'CANNOT_ACCESS'].includes(String(result.overallAccessState))) {
      findings.push({ id: probe.id, finding: 'UNKNOWN_OR_UNSUPPORTED_ACCESS_STATE' });
      hold = true;
      continue;
    }
    if (result.overallAccessState !== probe.expected_state) {
      findings.push({ id: probe.id, finding: 'PERMISSION_MISMATCH_REQUIRES_REVIEW' });
      review = true;
    }
  }
  return {
    project: PROJECT,
    state: hold ? 'hold' : review ? 'review_required' : 'sample_matches',
    findings,
    authorization_granted: false,
    full_permission_ceiling_verified: false,
    live_resource_readback_established: false,
  };
}
