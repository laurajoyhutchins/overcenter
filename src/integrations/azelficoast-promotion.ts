import { canonicalDigest } from '../digest.ts';
import {
  PROMOTION_SHADOW_SCHEMA,
  type PromotionShadowSnapshot,
} from '../governance/promotion-shadow.ts';

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

export function azelficoastPromotionCoordinate(
  evidence: AzelficoastPromotionEvidence,
  revision: string,
): string {
  validateEvidenceBoundary(evidence);
  return `sha256:${canonicalDigest({
    integration: 'azelficoast-battle-promotion',
    repository_revision: repositoryRevision(revision),
    schema: evidence.schema,
    schema_version: evidence.schema_version,
    candidate_checkpoint_digest: evidence.candidate_checkpoint_digest,
    incumbent_checkpoint_digest: evidence.incumbent_checkpoint_digest,
    deployment: evidence.deployment,
    policy: evidence.policy,
    results_digest: evidence.results_digest,
  })}`;
}

export function projectAzelficoastPromotionShadow(
  evidence: AzelficoastPromotionEvidence,
  revision: string,
): PromotionShadowSnapshot {
  const coordinate = azelficoastPromotionCoordinate(evidence, revision);
  const policyDigest = canonicalDigest(evidence.policy);
  const authority = `azelficoast:promotion-policy:${policyDigest}`;
  const candidate = `azelficoast:checkpoint:${evidence.candidate_checkpoint_digest}`;
  const incumbent = `azelficoast:checkpoint:${evidence.incumbent_checkpoint_digest}`;
  const results = `azelficoast:battle-results:${evidence.results_digest}`;
  const evaluation = `azelficoast:evaluate:${coordinate}`;
  const promotion = `azelficoast:promote:${evidence.candidate_checkpoint_digest}`;
  const admitted = 'azelficoast:promotion:admitted';
  const panelComplete = 'azelficoast:promotion:panel-complete';
  const checkPropositions = Object.fromEntries(
    CHECKS.map((check) => [check, `azelficoast:promotion:${check.replaceAll('_', '-')}`]),
  ) as Record<CheckName, string>;

  const requirements = [panelComplete, ...CHECKS.map((check) => checkPropositions[check])];
  const expectedBattles = evidence.policy.expected_battles;
  const complete =
    Number.isInteger(expectedBattles) &&
    expectedBattles > 0 &&
    evidence.battle_count === expectedBattles;

  return {
    schema: PROMOTION_SHADOW_SCHEMA,
    coordinate,
    objects: [authority, candidate, incumbent, results],
    events: [evaluation, promotion],
    propositions: [admitted, ...requirements],
    permits: [{ object_id: authority, event_id: promotion, coordinate }],
    asserts: CHECKS.filter((check) => evidence.checks[check] === true).map((check) => ({
      event_id: evaluation,
      proposition_id: checkPropositions[check],
      coordinate,
    })),
    supports: complete
      ? [{ object_id: results, proposition_id: panelComplete, coordinate }]
      : [],
    requires: requirements.map((required) => ({
      proposition_id: admitted,
      required_proposition_id: required,
      coordinate,
    })),
    decision: {
      authority_object_id: authority,
      evaluation_event_id: evaluation,
      promotion_event_id: promotion,
      promotion_proposition_id: admitted,
      legacy_admitted: evidence.admitted,
    },
  };
}
