/**
 * Fixed, read-only GCP IAM/WIF evidence acquisition.
 * This is deliberately not an IAM permission evaluator or mutation transport.
 */
export const GCP_IAM_CENSUS_PROJECT = 'project-6b810532-a302-48dc-b56' as const;

export interface GcpIamCensusTarget {
  readonly id: string;
  readonly command: readonly string[];
  readonly shape: 'object' | 'array';
}

const PROJECT = GCP_IAM_CENSUS_PROJECT;
const DEPLOYER = 'overcenter-deployer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com';
const OBSERVER = 'overcenter-observer@project-6b810532-a302-48dc-b56.iam.gserviceaccount.com';

export const GCP_IAM_CENSUS_TARGETS: readonly GcpIamCensusTarget[] = [
  {
    id: 'project-iam-allow',
    shape: 'object',
    command: ['projects', 'get-iam-policy', PROJECT, '--format=json'],
  },
  {
    id: 'project-ancestry',
    shape: 'array',
    command: ['projects', 'get-ancestors', PROJECT, '--format=json'],
  },
  {
    id: 'project-service-accounts',
    shape: 'array',
    command: ['iam', 'service-accounts', 'list', '--project=' + PROJECT, '--format=json'],
  },
  {
    id: 'project-custom-roles',
    shape: 'array',
    command: ['iam', 'roles', 'list', '--project=' + PROJECT, '--format=json'],
  },
  {
    id: 'existing-deployer-impersonation',
    shape: 'object',
    command: [
      'iam',
      'service-accounts',
      'get-iam-policy',
      DEPLOYER,
      '--project=' + PROJECT,
      '--format=json',
    ],
  },
  {
    id: 'proposed-observer-impersonation',
    shape: 'object',
    command: [
      'iam',
      'service-accounts',
      'get-iam-policy',
      OBSERVER,
      '--project=' + PROJECT,
      '--format=json',
    ],
  },
  {
    id: 'existing-github-wif-provider',
    shape: 'object',
    command: [
      'iam',
      'workload-identity-pools',
      'providers',
      'describe',
      'overcenter',
      '--workload-identity-pool=github',
      '--location=global',
      '--project=' + PROJECT,
      '--format=json',
    ],
  },
] as const;

export interface GcpIamCensusObservation {
  readonly id: string;
  readonly command: readonly string[];
  readonly observed_at: string;
  readonly outcome:
    | { readonly state: 'read'; readonly raw_response: unknown }
    | {
        readonly state: 'indeterminate';
        readonly reason: 'UNAVAILABLE_OR_DENIED' | 'INVALID_RESPONSE';
      };
}

export interface GcpIamCensus {
  readonly project: typeof GCP_IAM_CENSUS_PROJECT;
  readonly purpose: 'read-only-iam-trust-census';
  readonly direct_readbacks_complete: boolean;
  readonly effective_permissions_established: false;
  readonly authority_granted: false;
  readonly independently_verified: false;
  readonly observations: readonly GcpIamCensusObservation[];
}

/**
 * Run *only* enumerated, fixed read commands. No caller-controlled gcloud
 * arguments or read target. Failures and missing observer resources are holds,
 * not evidence of nonexistence or revoked authority.
 */
export function collectGcpIamCensus(
  runRead: (args: readonly string[]) => string,
  clock: () => string = () => new Date().toISOString(),
): GcpIamCensus {
  const observations: GcpIamCensusObservation[] = [];
  for (const target of GCP_IAM_CENSUS_TARGETS) {
    const observed_at = clock();
    try {
      const raw = JSON.parse(runRead(target.command)) as unknown;
      if (
        raw === null ||
        typeof raw !== 'object' ||
        (Array.isArray(raw) ? target.shape !== 'array' : target.shape !== 'object')
      ) {
        observations.push({
          id: target.id,
          command: target.command,
          observed_at,
          outcome: { state: 'indeterminate', reason: 'INVALID_RESPONSE' },
        });
        continue;
      }
      observations.push({
        id: target.id,
        command: target.command,
        observed_at,
        outcome: { state: 'read', raw_response: raw },
      });
    } catch {
      observations.push({
        id: target.id,
        command: target.command,
        observed_at,
        outcome: { state: 'indeterminate', reason: 'UNAVAILABLE_OR_DENIED' },
      });
    }
  }
  return {
    project: PROJECT,
    purpose: 'read-only-iam-trust-census',
    direct_readbacks_complete: observations.every((entry) => entry.outcome.state === 'read'),
    effective_permissions_established: false,
    authority_granted: false,
    independently_verified: false,
    observations,
  };
}
