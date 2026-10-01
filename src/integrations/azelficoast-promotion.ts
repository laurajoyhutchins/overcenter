import { canonicalDigest } from '../digest.ts';
import type { FourByFourProjection } from '../authority/effect-history-projection.ts';
import type { SqliteFourByFourCalculus } from '../authority/sqlite-calculus.ts';

const AZELFICOAST_PROMOTION_SCHEMA = 'azelficoast.battle-promotion-panel' as const;
const AZELFICOAST_PROMOTION_SCHEMA_VERSION = 2 as const;
const SHA256_IDENTITY = /^sha256:[0-9a-f]{64}$/;

const CHECKS = [
  'side_balance',
  'minimum_decisive_battles',
  'candidate_wins_more_than_loses',
  'superiority_p_value',
] as const;

type CheckName = (typeof CHECKS)[number];

export interface AzelficoastPromotionEvidence {
  schema: string;
  schema_version: number;
  candidate_checkpoint_digest: string;
  incumbent_checkpoint_digest: string;
  deployment: { search_policy_margin: number };
  policy: {
    expected_battles: number;
    max_superiority_p_value: number;
    min_decisive_fraction: number;
  };
  battle_count: number;
  checks: Partial<Record<CheckName, boolean>>;
  results_digest: string;
  admitted: boolean;
}

export interface AzelficoastPromotionBoundary {
  coordinate: string;
  projection: FourByFourProjection;
  ids: {
    promotion_event: string;
    promotion_proposition: string;
    panel_complete_proposition: string;
    check_propositions: Record<CheckName, string>;
  };
  legacy_admitted: boolean;
}

export interface AzelficoastPromotionShadowDecision {
  head: string;
  coordinate: string;
  admitted: boolean;
  legacy_admitted: boolean;
  agrees: boolean;
  exact_permit: boolean;
  unsupported_requirements: string[];
  stale_supports: string[];
  stale_permissions: string[];
  reasons: string[];
}

function exactSha256Identity(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256_IDENTITY.test(value)) {
    throw new Error(`AZELFICOAST_PROMOTION_INVALID:${label}`);
  }
}

function repositoryRevision(value: string): string {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('AZELFICOAST_PROMOTION_INVALID:REVISION');
  }
  return value;
}

function validateEvidenceBoundary(evidence: AzelficoastPromotionEvidence): void {
  if (
    evidence.schema !== AZELFICOAST_PROMOTION_SCHEMA ||
    evidence.schema_version !== AZELFICOAST_PROMOTION_SCHEMA_VERSION
  ) {
    throw new Error('AZELFICOAST_PROMOTION_INVALID:SCHEMA');
  }
  exactSha256Identity(evidence.candidate_checkpoint_digest, 'CANDIDATE');
  exactSha256Identity(evidence.incumbent_checkpoint_digest, 'INCUMBENT');
  exactSha256Identity(evidence.results_digest, 'RESULTS_DIGEST');
  if (evidence.candidate_checkpoint_digest === evidence.incumbent_checkpoint_digest) {
    throw new Error('AZELFICOAST_PROMOTION_INVALID:IDENTICAL_CHECKPOINTS');
  }
  if (typeof evidence.admitted !== 'boolean') {
    throw new Error('AZELFICOAST_PROMOTION_INVALID:ADMITTED');
  }
}

function semanticId(kind: string, value: unknown): string {
  return `azelficoast:${kind}:${canonicalDigest({
    domain: `azelficoast-promotion-${kind}/v1`,
    value,
  })}`;
}

export function azelficoastPromotionCoordinate(
  evidence: AzelficoastPromotionEvidence,
  revision: string,
): string {
  validateEvidenceBoundary(evidence);
  return semanticId('coordinate', {
    repository_revision: repositoryRevision(revision),
    schema: evidence.schema,
    schema_version: evidence.schema_version,
    candidate_checkpoint_digest: evidence.candidate_checkpoint_digest,
    incumbent_checkpoint_digest: evidence.incumbent_checkpoint_digest,
    deployment: evidence.deployment,
    policy: evidence.policy,
    results_digest: evidence.results_digest,
  });
}

export function projectAzelficoastPromotionBoundary(
  evidence: AzelficoastPromotionEvidence,
  revision: string,
): AzelficoastPromotionBoundary {
  const coordinate = azelficoastPromotionCoordinate(evidence, revision);
  const sources = [] as const;
  const policy = semanticId('object', { coordinate, role: 'promotion-policy' });
  const candidate = semanticId('object', {
    coordinate,
    role: 'candidate-checkpoint',
    digest: evidence.candidate_checkpoint_digest,
  });
  const incumbent = semanticId('object', {
    coordinate,
    role: 'incumbent-checkpoint',
    digest: evidence.incumbent_checkpoint_digest,
  });
  const results = semanticId('object', {
    coordinate,
    role: 'battle-results',
    digest: evidence.results_digest,
  });
  const evaluation = semanticId('event', { coordinate, role: 'promotion-evaluation' });
  const promotion = semanticId('event', {
    coordinate,
    role: 'candidate-promotion',
    candidate: evidence.candidate_checkpoint_digest,
  });
  const admitted = semanticId('proposition', {
    coordinate,
    role: 'promotion-admissible',
  });
  const panelComplete = semanticId('proposition', {
    coordinate,
    role: 'panel-complete',
  });
  const checkPropositions = Object.fromEntries(
    CHECKS.map((check) => [
      check,
      semanticId('proposition', { coordinate, role: 'playing-strength-check', check }),
    ]),
  ) as Record<CheckName, string>;

  const expectedBattles = evidence.policy.expected_battles;
  const complete =
    Number.isInteger(expectedBattles) &&
    expectedBattles > 0 &&
    evidence.battle_count === expectedBattles;
  const supportedChecks = CHECKS.filter((check) => evidence.checks[check] === true);
  const required = [panelComplete, ...CHECKS.map((check) => checkPropositions[check])];

  const projection: FourByFourProjection = {
    coordinates: [
      {
        id: coordinate,
        value: {
          repository_revision: revision,
          schema: evidence.schema,
          schema_version: evidence.schema_version,
          candidate_checkpoint_digest: evidence.candidate_checkpoint_digest,
          incumbent_checkpoint_digest: evidence.incumbent_checkpoint_digest,
          deployment: evidence.deployment,
          policy: evidence.policy,
          results_digest: evidence.results_digest,
        },
        sources: [...sources],
      },
    ],
    objects: [
      {
        id: policy,
        coordinate,
        role: 'promotion-policy',
        value: {
          deployment: evidence.deployment,
          policy: evidence.policy,
        },
        sources: [...sources],
      },
      {
        id: candidate,
        coordinate,
        role: 'candidate-checkpoint',
        value: { digest: evidence.candidate_checkpoint_digest },
        sources: [...sources],
      },
      {
        id: incumbent,
        coordinate,
        role: 'incumbent-checkpoint',
        value: { digest: evidence.incumbent_checkpoint_digest },
        sources: [...sources],
      },
      {
        id: results,
        coordinate,
        role: 'battle-results',
        value: {
          digest: evidence.results_digest,
          battle_count: evidence.battle_count,
        },
        sources: [...sources],
      },
    ],
    events: [
      {
        id: evaluation,
        coordinate,
        role: 'promotion-evaluation',
        value: {
          schema: evidence.schema,
          schema_version: evidence.schema_version,
        },
        sources: [...sources],
      },
      {
        id: promotion,
        coordinate,
        role: 'candidate-promotion',
        value: {
          candidate_checkpoint_digest: evidence.candidate_checkpoint_digest,
          incumbent_checkpoint_digest: evidence.incumbent_checkpoint_digest,
        },
        sources: [...sources],
      },
    ],
    propositions: [
      {
        id: admitted,
        coordinate,
        role: 'promotion-admissible',
        value: {},
        sources: [...sources],
      },
      {
        id: panelComplete,
        coordinate,
        role: 'panel-complete',
        value: {
          expected_battles: expectedBattles,
          battle_count: evidence.battle_count,
        },
        sources: [...sources],
      },
      ...CHECKS.map((check) => ({
        id: checkPropositions[check],
        coordinate,
        role: 'playing-strength-check',
        value: { check },
        sources: [...sources],
      })),
    ],
    permits: [
      {
        id: semanticId('permits', { object: policy, event: promotion }),
        object: policy,
        event: promotion,
        sources: [...sources],
      },
    ],
    asserts: [
      ...(complete
        ? [
            {
              id: semanticId('asserts', {
                event: evaluation,
                proposition: panelComplete,
              }),
              event: evaluation,
              proposition: panelComplete,
              sources: [...sources],
            },
          ]
        : []),
      ...supportedChecks.map((check) => ({
        id: semanticId('asserts', {
          event: evaluation,
          proposition: checkPropositions[check],
        }),
        event: evaluation,
        proposition: checkPropositions[check],
        sources: [...sources],
      })),
    ],
    supports: [
      ...(complete
        ? [
            {
              id: semanticId('supports', {
                object: results,
                proposition: panelComplete,
              }),
              object: results,
              proposition: panelComplete,
              sources: [...sources],
            },
          ]
        : []),
      ...supportedChecks.map((check) => ({
        id: semanticId('supports', {
          object: results,
          proposition: checkPropositions[check],
        }),
        object: results,
        proposition: checkPropositions[check],
        sources: [...sources],
      })),
    ],
    requires: required.map((requiredProposition) => ({
      id: semanticId('requires', {
        proposition: admitted,
        required: requiredProposition,
      }),
      proposition: admitted,
      required: requiredProposition,
      sources: [...sources],
    })),
  };

  return {
    coordinate,
    projection,
    ids: {
      promotion_event: promotion,
      promotion_proposition: admitted,
      panel_complete_proposition: panelComplete,
      check_propositions: checkPropositions,
    },
    legacy_admitted: evidence.admitted,
  };
}

export function shadowAzelficoastPromotion(
  calculus: SqliteFourByFourCalculus,
  durableHead: string,
  boundary: AzelficoastPromotionBoundary,
): AzelficoastPromotionShadowDecision {
  calculus.replaceProjection(durableHead, boundary.projection);

  const permitted = calculus.permittedEvents(boundary.coordinate);
  const unsupported = calculus.unsupportedRequirements(boundary.ids.promotion_proposition);
  const staleSupports = calculus.staleSupports(boundary.coordinate);
  const stalePermissions = calculus.stalePermissions(boundary.coordinate);
  const heads = new Set([
    permitted.head,
    unsupported.head,
    staleSupports.head,
    stalePermissions.head,
  ]);
  if (heads.size !== 1 || !heads.has(durableHead)) {
    throw new Error('AZELFICOAST_PROMOTION_SHADOW_HEAD_MISMATCH');
  }

  const exactPermit = permitted.value.includes(boundary.ids.promotion_event);
  const staleSupportIds = staleSupports.value.map((row) => row.id);
  const stalePermissionIds = stalePermissions.value.map((row) => row.id);
  const admitted =
    exactPermit &&
    unsupported.value.length === 0 &&
    staleSupportIds.length === 0 &&
    stalePermissionIds.length === 0;
  const reasons: string[] = [];
  if (!exactPermit) reasons.push('NO_EXACT_PERMIT');
  reasons.push(
    ...unsupported.value.map((proposition) => `UNSUPPORTED_REQUIREMENT:${proposition}`),
  );
  reasons.push(...staleSupportIds.map((id) => `STALE_SUPPORT:${id}`));
  reasons.push(...stalePermissionIds.map((id) => `STALE_PERMISSION:${id}`));
  if (admitted !== boundary.legacy_admitted) reasons.push('LEGACY_DISAGREEMENT');

  return {
    head: durableHead,
    coordinate: boundary.coordinate,
    admitted,
    legacy_admitted: boundary.legacy_admitted,
    agrees: admitted === boundary.legacy_admitted,
    exact_permit: exactPermit,
    unsupported_requirements: unsupported.value,
    stale_supports: staleSupportIds,
    stale_permissions: stalePermissionIds,
    reasons,
  };
}
