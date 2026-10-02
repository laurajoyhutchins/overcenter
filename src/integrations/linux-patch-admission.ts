import type { FourByFourProjection } from '../authority/effect-history-projection.ts';
import type { SqliteFourByFourCalculus } from '../authority/sqlite-calculus.ts';
import { canonicalDigest } from '../digest.ts';

const LINUX_PATCH_SCHEMA = 'linux.patch-admission-history' as const;
const LINUX_PATCH_SCHEMA_VERSION = 1 as const;
const SHA256_IDENTITY = /^sha256:[0-9a-f]{64}$/;
const GIT_IDENTITY = /^[0-9a-f]{40}$/;

const MECHANICAL_CHECKS = [
  'exact_base',
  'correct_routing',
  'series_complete',
  'required_review',
  'required_tests',
] as const;

type MechanicalCheck = (typeof MECHANICAL_CHECKS)[number];

export type LinuxMaintainerDisposition = 'accepted' | 'rejected' | 'unknown';
export type LinuxPublicState = 'accepted' | 'queued' | 'rejected' | 'unknown';

export interface LinuxExternalPrerequisite {
  id: string;
  project: string;
  revision: string;
  evidence_digest: string;
  satisfied: boolean;
}

export interface LinuxPatchAdmissionEvidence {
  schema: string;
  schema_version: number;
  kernel_revision: string;
  series: {
    message_id: string;
    version: number;
    patch_count: number;
    digest: string;
  };
  target: {
    subsystem: string;
    tree: string;
    branch: string;
    base_commit: string;
  };
  authority: {
    maintainer: string;
    source_digest: string;
  };
  evidence_digest: string;
  checks: Partial<Record<MechanicalCheck, boolean>>;
  external_prerequisites: LinuxExternalPrerequisite[];
  maintainer_disposition: LinuxMaintainerDisposition;
  public_state: LinuxPublicState;
}

export interface LinuxPatchAdmissionBoundary {
  coordinate: string;
  projection: FourByFourProjection;
  ids: {
    integration_event: string;
    admission_proposition: string;
    maintainer_acceptance_proposition: string;
    check_propositions: Record<MechanicalCheck, string>;
    external_propositions: Record<string, string>;
  };
  public_state: LinuxPublicState;
  maintainer_disposition: LinuxMaintainerDisposition;
}

export interface LinuxPatchAdmissionDecision {
  head: string;
  coordinate: string;
  admitted: boolean;
  public_state: LinuxPublicState;
  agrees_with_public_acceptance: boolean;
  judgment_required: boolean;
  exact_permit: boolean;
  unsupported_requirements: string[];
  stale_supports: string[];
  stale_permissions: string[];
  reasons: string[];
}

function exactSha256Identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_IDENTITY.test(value)) {
    throw new Error(`LINUX_PATCH_INVALID:${label}`);
  }
}

function gitIdentity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !GIT_IDENTITY.test(value)) {
    throw new Error(`LINUX_PATCH_INVALID:${label}`);
  }
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`LINUX_PATCH_INVALID:${label}`);
  }
}

function semanticId(kind: string, value: unknown): string {
  return `linux:${kind}:${canonicalDigest({
    domain: `linux-patch-admission-${kind}/v1`,
    value,
  })}`;
}

function validateEvidence(evidence: LinuxPatchAdmissionEvidence): void {
  if (
    evidence.schema !== LINUX_PATCH_SCHEMA ||
    evidence.schema_version !== LINUX_PATCH_SCHEMA_VERSION
  ) {
    throw new Error('LINUX_PATCH_INVALID:SCHEMA');
  }

  gitIdentity(evidence.kernel_revision, 'KERNEL_REVISION');
  gitIdentity(evidence.target.base_commit, 'BASE_COMMIT');
  exactSha256Identity(evidence.series.digest, 'SERIES_DIGEST');
  exactSha256Identity(evidence.authority.source_digest, 'AUTHORITY_SOURCE');
  exactSha256Identity(evidence.evidence_digest, 'EVIDENCE_DIGEST');

  nonEmpty(evidence.series.message_id, 'MESSAGE_ID');
  nonEmpty(evidence.target.subsystem, 'SUBSYSTEM');
  nonEmpty(evidence.target.tree, 'TREE');
  nonEmpty(evidence.target.branch, 'BRANCH');
  nonEmpty(evidence.authority.maintainer, 'MAINTAINER');

  if (!Number.isInteger(evidence.series.version) || evidence.series.version < 1) {
    throw new Error('LINUX_PATCH_INVALID:SERIES_VERSION');
  }
  if (!Number.isInteger(evidence.series.patch_count) || evidence.series.patch_count < 1) {
    throw new Error('LINUX_PATCH_INVALID:PATCH_COUNT');
  }

  const seen = new Set<string>();
  for (const prerequisite of evidence.external_prerequisites) {
    nonEmpty(prerequisite.id, 'EXTERNAL_ID');
    nonEmpty(prerequisite.project, 'EXTERNAL_PROJECT');
    gitIdentity(prerequisite.revision, 'EXTERNAL_REVISION');
    exactSha256Identity(prerequisite.evidence_digest, 'EXTERNAL_EVIDENCE');
    if (seen.has(prerequisite.id)) throw new Error('LINUX_PATCH_INVALID:DUPLICATE_EXTERNAL_ID');
    seen.add(prerequisite.id);
  }
}

export function linuxPatchCoordinate(evidence: LinuxPatchAdmissionEvidence): string {
  validateEvidence(evidence);
  return semanticId('coordinate', {
    kernel_revision: evidence.kernel_revision,
    series: evidence.series,
    target: evidence.target,
    authority: evidence.authority,
    external_prerequisites: evidence.external_prerequisites.map((item) => ({
      id: item.id,
      project: item.project,
      revision: item.revision,
      evidence_digest: item.evidence_digest,
    })),
  });
}

export function projectLinuxPatchAdmissionBoundary(
  evidence: LinuxPatchAdmissionEvidence,
): LinuxPatchAdmissionBoundary {
  const coordinate = linuxPatchCoordinate(evidence);
  const sources = [] as const;

  const patchSeries = semanticId('object', {
    coordinate,
    role: 'patch-series',
    series: evidence.series,
  });
  const publicEvidence = semanticId('object', {
    coordinate,
    role: 'public-evidence',
    digest: evidence.evidence_digest,
  });
  const maintainerAuthority = semanticId('object', {
    coordinate,
    role: 'maintainer-authority',
    maintainer: evidence.authority.maintainer,
    source_digest: evidence.authority.source_digest,
  });
  const maintainerDecision = semanticId('object', {
    coordinate,
    role: 'maintainer-decision',
    disposition: evidence.maintainer_disposition,
  });

  const observation = semanticId('event', { coordinate, role: 'public-observation' });
  const judgment = semanticId('event', { coordinate, role: 'maintainer-judgment' });
  const integration = semanticId('event', {
    coordinate,
    role: 'subsystem-integration',
    series_digest: evidence.series.digest,
  });

  const admission = semanticId('proposition', {
    coordinate,
    role: 'integration-admissible',
  });
  const maintainerAcceptance = semanticId('proposition', {
    coordinate,
    role: 'maintainer-acceptance',
  });

  const checkPropositions = Object.fromEntries(
    MECHANICAL_CHECKS.map((check) => [
      check,
      semanticId('proposition', {
        coordinate,
        role: 'mechanical-check',
        check,
      }),
    ]),
  ) as Record<MechanicalCheck, string>;

  const externalPropositions = Object.fromEntries(
    evidence.external_prerequisites.map((item) => [
      item.id,
      semanticId('proposition', {
        coordinate,
        role: 'external-prerequisite',
        id: item.id,
        project: item.project,
        revision: item.revision,
      }),
    ]),
  );

  const externalObjects = evidence.external_prerequisites.map((item) => ({
    id: semanticId('object', {
      coordinate,
      role: 'external-evidence',
      id: item.id,
      project: item.project,
      digest: item.evidence_digest,
    }),
    coordinate,
    role: 'external-evidence',
    value: {
      id: item.id,
      project: item.project,
      revision: item.revision,
      evidence_digest: item.evidence_digest,
    },
    sources: [...sources],
  }));

  const supportedChecks = MECHANICAL_CHECKS.filter((check) => evidence.checks[check] === true);
  const satisfiedExternal = evidence.external_prerequisites.filter((item) => item.satisfied);

  const projection: FourByFourProjection = {
    coordinates: [
      {
        id: coordinate,
        value: {
          kernel_revision: evidence.kernel_revision,
          series: evidence.series,
          target: evidence.target,
          authority: evidence.authority,
          external_prerequisites: evidence.external_prerequisites.map((item) => ({
            id: item.id,
            project: item.project,
            revision: item.revision,
            evidence_digest: item.evidence_digest,
          })),
        },
        sources: [...sources],
      },
    ],
    objects: [
      {
        id: patchSeries,
        coordinate,
        role: 'patch-series',
        value: evidence.series,
        sources: [...sources],
      },
      {
        id: publicEvidence,
        coordinate,
        role: 'public-evidence',
        value: { digest: evidence.evidence_digest },
        sources: [...sources],
      },
      {
        id: maintainerAuthority,
        coordinate,
        role: 'maintainer-authority',
        value: evidence.authority,
        sources: [...sources],
      },
      {
        id: maintainerDecision,
        coordinate,
        role: 'maintainer-decision',
        value: { disposition: evidence.maintainer_disposition },
        sources: [...sources],
      },
      ...externalObjects,
    ],
    events: [
      {
        id: observation,
        coordinate,
        role: 'public-observation',
        value: {
          message_id: evidence.series.message_id,
          version: evidence.series.version,
        },
        sources: [...sources],
      },
      {
        id: judgment,
        coordinate,
        role: 'maintainer-judgment',
        value: { disposition: evidence.maintainer_disposition },
        sources: [...sources],
      },
      {
        id: integration,
        coordinate,
        role: 'subsystem-integration',
        value: {
          subsystem: evidence.target.subsystem,
          tree: evidence.target.tree,
          branch: evidence.target.branch,
        },
        sources: [...sources],
      },
    ],
    propositions: [
      {
        id: admission,
        coordinate,
        role: 'integration-admissible',
        value: {},
        sources: [...sources],
      },
      {
        id: maintainerAcceptance,
        coordinate,
        role: 'maintainer-acceptance',
        value: {},
        sources: [...sources],
      },
      ...MECHANICAL_CHECKS.map((check) => ({
        id: checkPropositions[check],
        coordinate,
        role: 'mechanical-check',
        value: { check },
        sources: [...sources],
      })),
      ...evidence.external_prerequisites.map((item) => ({
        id: externalPropositions[item.id],
        coordinate,
        role: 'external-prerequisite',
        value: {
          id: item.id,
          project: item.project,
          revision: item.revision,
        },
        sources: [...sources],
      })),
    ],
    permits: [
      {
        id: semanticId('permits', { object: maintainerAuthority, event: integration }),
        object: maintainerAuthority,
        event: integration,
        sources: [...sources],
      },
    ],
    asserts: [
      ...supportedChecks.map((check) => ({
        id: semanticId('asserts', {
          event: observation,
          proposition: checkPropositions[check],
        }),
        event: observation,
        proposition: checkPropositions[check],
        sources: [...sources],
      })),
      ...satisfiedExternal.map((item) => ({
        id: semanticId('asserts', {
          event: observation,
          proposition: externalPropositions[item.id],
        }),
        event: observation,
        proposition: externalPropositions[item.id],
        sources: [...sources],
      })),
      ...(evidence.maintainer_disposition === 'accepted'
        ? [
            {
              id: semanticId('asserts', {
                event: judgment,
                proposition: maintainerAcceptance,
              }),
              event: judgment,
              proposition: maintainerAcceptance,
              sources: [...sources],
            },
          ]
        : []),
    ],
    supports: [
      ...supportedChecks.map((check) => ({
        id: semanticId('supports', {
          object: publicEvidence,
          proposition: checkPropositions[check],
        }),
        object: publicEvidence,
        proposition: checkPropositions[check],
        sources: [...sources],
      })),
      ...satisfiedExternal.map((item) => {
        const object = externalObjects.find(
          (candidate) => candidate.value.id === item.id,
        );
        if (!object) throw new Error('LINUX_PATCH_INTERNAL:MISSING_EXTERNAL_OBJECT');
        return {
          id: semanticId('supports', {
            object: object.id,
            proposition: externalPropositions[item.id],
          }),
          object: object.id,
          proposition: externalPropositions[item.id],
          sources: [...sources],
        };
      }),
      ...(evidence.maintainer_disposition === 'accepted'
        ? [
            {
              id: semanticId('supports', {
                object: maintainerDecision,
                proposition: maintainerAcceptance,
              }),
              object: maintainerDecision,
              proposition: maintainerAcceptance,
              sources: [...sources],
            },
          ]
        : []),
    ],
    requires: [
      ...MECHANICAL_CHECKS.map((check) => ({
        id: semanticId('requires', {
          proposition: admission,
          required: checkPropositions[check],
        }),
        proposition: admission,
        required: checkPropositions[check],
        sources: [...sources],
      })),
      ...evidence.external_prerequisites.map((item) => ({
        id: semanticId('requires', {
          proposition: admission,
          required: externalPropositions[item.id],
        }),
        proposition: admission,
        required: externalPropositions[item.id],
        sources: [...sources],
      })),
      {
        id: semanticId('requires', {
          proposition: admission,
          required: maintainerAcceptance,
        }),
        proposition: admission,
        required: maintainerAcceptance,
        sources: [...sources],
      },
    ],
  };

  return {
    coordinate,
    projection,
    ids: {
      integration_event: integration,
      admission_proposition: admission,
      maintainer_acceptance_proposition: maintainerAcceptance,
      check_propositions: checkPropositions,
      external_propositions: externalPropositions,
    },
    public_state: evidence.public_state,
    maintainer_disposition: evidence.maintainer_disposition,
  };
}

export function shadowLinuxPatchAdmission(
  calculus: SqliteFourByFourCalculus,
  durableHead: string,
  boundary: LinuxPatchAdmissionBoundary,
): LinuxPatchAdmissionDecision {
  calculus.replaceProjection(durableHead, boundary.projection);

  const permitted = calculus.permittedEvents(boundary.coordinate);
  const unsupported = calculus.unsupportedRequirements(boundary.ids.admission_proposition);
  const staleSupports = calculus.staleSupports(boundary.coordinate);
  const stalePermissions = calculus.stalePermissions(boundary.coordinate);
  const heads = new Set([
    permitted.head,
    unsupported.head,
    staleSupports.head,
    stalePermissions.head,
  ]);

  if (heads.size !== 1 || !heads.has(durableHead)) {
    throw new Error('LINUX_PATCH_SHADOW_HEAD_MISMATCH');
  }

  const exactPermit = permitted.value.includes(boundary.ids.integration_event);
  const staleSupportIds = staleSupports.value.map((row) => row.id);
  const stalePermissionIds = stalePermissions.value.map((row) => row.id);
  const judgmentRequired =
    boundary.maintainer_disposition === 'unknown' &&
    unsupported.value.includes(boundary.ids.maintainer_acceptance_proposition);
  const admitted =
    exactPermit &&
    unsupported.value.length === 0 &&
    staleSupportIds.length === 0 &&
    stalePermissionIds.length === 0;

  const reasons: string[] = [];
  if (!exactPermit) reasons.push('NO_EXACT_PERMIT');
  if (judgmentRequired) reasons.push('MAINTAINER_JUDGMENT_REQUIRED');
  if (boundary.maintainer_disposition === 'rejected') reasons.push('MAINTAINER_REJECTED');
  reasons.push(...unsupported.value.map((id) => `UNSUPPORTED_REQUIREMENT:${id}`));
  reasons.push(...staleSupportIds.map((id) => `STALE_SUPPORT:${id}`));
  reasons.push(...stalePermissionIds.map((id) => `STALE_PERMISSION:${id}`));

  const publicAccepted = boundary.public_state === 'accepted';
  if (admitted !== publicAccepted) reasons.push('PUBLIC_HISTORY_DISAGREEMENT');

  return {
    head: durableHead,
    coordinate: boundary.coordinate,
    admitted,
    public_state: boundary.public_state,
    agrees_with_public_acceptance: admitted === publicAccepted,
    judgment_required: judgmentRequired,
    exact_permit: exactPermit,
    unsupported_requirements: unsupported.value,
    stale_supports: staleSupportIds,
    stale_permissions: stalePermissionIds,
    reasons,
  };
}
