import type { DatabaseSync } from 'node:sqlite';

import type { AssuranceChangePlan } from '../architecture/change-planner.ts';
import { deriveAssurancePropertyTrustRoots } from '../architecture/tcb.ts';

export const ASSURANCE_RELATION_COORDINATE = 'architecture/current' as const;

export interface PropositionSupport {
  object_id: string;
  proposition_id: string;
  coordinate: string;
}

export interface PropositionSupportExplanation {
  proposition_id: string;
  resolution: 'already-supported' | 'selected-evidence';
  object_ids: string[];
}

export interface MinimumSufficientEvidenceSet {
  coordinate: string;
  required_propositions: string[];
  already_supported_propositions: string[];
  selected_object_ids: string[];
  alternative_minimum_object_sets: string[][];
  explanations: PropositionSupportExplanation[];
}

interface EvidenceArtifactRow {
  evidence_id: string;
  artifact_id: string;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function compareStringSets(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = left[index]!.localeCompare(right[index]!);
    if (comparison !== 0) return comparison;
  }
  return left.length - right.length;
}

function propertyIds(value: string | readonly string[]): string[] {
  return [...new Set(typeof value === 'string' ? [value] : value)].sort();
}

export function minimumSufficientEvidenceSet(
  propositions: readonly string[],
  availableSupports: readonly PropositionSupport[],
  coordinate: string,
  existingSupports: readonly PropositionSupport[] = [],
): MinimumSufficientEvidenceSet {
  const required = [...new Set(propositions)].sort();
  const requiredSet = new Set(required);

  const existingByProposition = new Map<string, Set<string>>();
  for (const support of existingSupports) {
    if (support.coordinate !== coordinate || !requiredSet.has(support.proposition_id)) continue;
    const objects = existingByProposition.get(support.proposition_id) ?? new Set<string>();
    objects.add(support.object_id);
    existingByProposition.set(support.proposition_id, objects);
  }

  const alreadySupported = [...existingByProposition.keys()].sort();
  const pending = required.filter((proposition) => !existingByProposition.has(proposition));
  const pendingSet = new Set(pending);
  const coverage = new Map<string, Set<string>>();
  for (const support of availableSupports) {
    if (support.coordinate !== coordinate || !pendingSet.has(support.proposition_id)) continue;
    const covered = coverage.get(support.object_id) ?? new Set<string>();
    covered.add(support.proposition_id);
    coverage.set(support.object_id, covered);
  }

  const uncovered = pending.filter(
    (proposition) => ![...coverage.values()].some((covered) => covered.has(proposition)),
  );
  if (uncovered.length > 0) {
    throw new Error(`ASSURANCE_SUPPORT_INCOMPLETE:${uncovered.join(',')}:coordinate=${coordinate}`);
  }

  const candidates = [...coverage.keys()].sort();
  const minimumSets: string[][] = [];
  let bestSize = Number.POSITIVE_INFINITY;
  const search = (index: number, selected: string[], covered: Set<string>): void => {
    if (pending.every((proposition) => covered.has(proposition))) {
      if (selected.length < bestSize) {
        bestSize = selected.length;
        minimumSets.length = 0;
      }
      if (selected.length === bestSize) minimumSets.push(selected);
      return;
    }
    if (index >= candidates.length || selected.length >= bestSize) return;

    const objectId = candidates[index]!;
    search(
      index + 1,
      [...selected, objectId],
      new Set([...covered, ...(coverage.get(objectId) ?? [])]),
    );
    search(index + 1, selected, covered);
  };

  search(0, [], new Set());
  if (minimumSets.length === 0) {
    throw new Error(`ASSURANCE_SUPPORT_INCOMPLETE:${pending.join(',')}:coordinate=${coordinate}`);
  }
  minimumSets.sort(compareStringSets);
  const selected = minimumSets[0] ?? [];

  return {
    coordinate,
    required_propositions: required,
    already_supported_propositions: alreadySupported,
    selected_object_ids: selected,
    alternative_minimum_object_sets: minimumSets.slice(1),
    explanations: required.map((proposition): PropositionSupportExplanation => {
      const existing = existingByProposition.get(proposition);
      if (existing) {
        return {
          proposition_id: proposition,
          resolution: 'already-supported',
          object_ids: [...existing].sort(),
        };
      }
      return {
        proposition_id: proposition,
        resolution: 'selected-evidence',
        object_ids: selected.filter((objectId) => coverage.get(objectId)?.has(proposition)).sort(),
      };
    }),
  };
}

export function minimumSupportCover(
  propositions: readonly string[],
  rows: readonly PropositionSupport[],
  coordinate: string,
): string[] {
  return minimumSufficientEvidenceSet(propositions, rows, coordinate).selected_object_ids;
}

export function assuranceRequirementClosure(
  db: DatabaseSync,
  properties: string | readonly string[],
): string[] {
  const goals = propertyIds(properties);
  if (goals.length === 0) return [];

  const known = new Set(
    (
      db
        .prepare(`
          SELECT property_id
          FROM assurance_property
          WHERE property_id IN (${placeholders(goals)})
          ORDER BY property_id
        `)
        .all(...goals) as unknown as Array<{ property_id: string }>
    ).map((row) => row.property_id),
  );
  const unknown = goals.filter((propertyId) => !known.has(propertyId));
  if (unknown.length > 0) throw new Error(`ASSURANCE_PROPERTY_UNKNOWN:${unknown.join(',')}`);

  return (
    db
      .prepare(`
        WITH RECURSIVE
        requires(proposition_id, required_proposition_id) AS (
          SELECT
            'property:' || property_id,
            'property:' || required_property_id
          FROM assurance_property_composes_with

          UNION

          SELECT
            'property:' || guarded.property_id,
            'obligation:' || obligation.obligation_id
          FROM assurance_property_guards_effect AS guarded
          JOIN obligation_guards_effect AS obligation
            ON obligation.effect_id = guarded.effect_id

          UNION

          SELECT
            'property:' || property.property_id,
            'proof:' || property.property_id
          FROM assurance_property AS property
          WHERE NOT EXISTS (
            SELECT 1 FROM assurance_property_composes_with AS composition
            WHERE composition.property_id = property.property_id
          )
            AND NOT EXISTS (
              SELECT 1 FROM assurance_property_guards_effect AS guarded
              WHERE guarded.property_id = property.property_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM assurance_property_requires_authority AS authority
              WHERE authority.property_id = property.property_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM assurance_property_requires_capability AS capability
              WHERE capability.property_id = property.property_id
            )
            AND NOT EXISTS (
              SELECT 1 FROM assurance_property_requires_effect_implementation AS implementation
              WHERE implementation.property_id = property.property_id
            )
        ),
        closure(proposition_id) AS (
          SELECT 'property:' || property_id
          FROM assurance_property
          WHERE property_id IN (${placeholders(goals)})

          UNION

          SELECT requires.required_proposition_id
          FROM requires
          JOIN closure AS current
            ON requires.proposition_id = current.proposition_id
        )
        SELECT proposition_id
        FROM closure
        ORDER BY proposition_id
      `)
      .all(...goals) as unknown as Array<{ proposition_id: string }>
  ).map((row) => row.proposition_id);
}

function candidateSupports(db: DatabaseSync, coordinate: string): PropositionSupport[] {
  return db
    .prepare(`
      SELECT
        evidence_id AS object_id,
        'obligation:' || obligation_id AS proposition_id,
        ? AS coordinate
      FROM evidence_witnesses_obligation

      UNION ALL

      SELECT
        evidence_id AS object_id,
        'proof:' || property_id AS proposition_id,
        ? AS coordinate
      FROM evidence_witnesses_assurance_property

      ORDER BY object_id, proposition_id
    `)
    .all(coordinate, coordinate) as unknown as PropositionSupport[];
}

export function assuranceEvidenceFrontierFromRelations(
  db: DatabaseSync,
  properties: string | readonly string[],
  coordinate: string = ASSURANCE_RELATION_COORDINATE,
  existingSupports: readonly PropositionSupport[] = [],
): MinimumSufficientEvidenceSet {
  const closure = assuranceRequirementClosure(db, properties);
  const requiredProofs = closure.filter(
    (proposition) => proposition.startsWith('obligation:') || proposition.startsWith('proof:'),
  );
  return minimumSufficientEvidenceSet(
    requiredProofs,
    candidateSupports(db, coordinate),
    coordinate,
    existingSupports,
  );
}

export function assuranceChangePlanForPropertiesFromRelations(
  db: DatabaseSync,
  propertyIdsValue: readonly string[],
  coordinate: string = ASSURANCE_RELATION_COORDINATE,
  existingSupports: readonly PropositionSupport[] = [],
): AssuranceChangePlan {
  const closure = assuranceRequirementClosure(db, propertyIdsValue);
  const properties = closure
    .filter((proposition) => proposition.startsWith('property:'))
    .map((proposition) => proposition.slice('property:'.length));
  if (properties.length === 0) {
    return { properties: [], effects: [], obligations: [], evidence: [], realization_roots: [] };
  }

  const obligationPropositions = closure.filter((proposition) =>
    proposition.startsWith('obligation:'),
  );
  const obligations = obligationPropositions.map((proposition) =>
    proposition.slice('obligation:'.length),
  );
  const effects = (
    db
      .prepare(`
        SELECT DISTINCT effect_id
        FROM assurance_property_guards_effect
        WHERE property_id IN (${placeholders(properties)})
        ORDER BY effect_id
      `)
      .all(...properties) as unknown as Array<{ effect_id: string }>
  ).map((row) => row.effect_id);

  const supports = candidateSupports(db, coordinate);
  const frontier = minimumSufficientEvidenceSet(
    closure.filter(
      (proposition) => proposition.startsWith('obligation:') || proposition.startsWith('proof:'),
    ),
    supports,
    coordinate,
    existingSupports,
  );
  const selectedEvidence = frontier.selected_object_ids;
  const witnessRows =
    selectedEvidence.length === 0
      ? []
      : (db
          .prepare(`
            SELECT evidence_id, artifact_id
            FROM artifact_witnesses_evidence
            WHERE evidence_id IN (${placeholders(selectedEvidence)})
            ORDER BY evidence_id, artifact_id
          `)
          .all(...selectedEvidence) as unknown as EvidenceArtifactRow[]);

  const unrealized = selectedEvidence.filter(
    (evidenceId) => !witnessRows.some((row) => row.evidence_id === evidenceId),
  );
  if (unrealized.length > 0) {
    throw new Error(`ASSURANCE_EVIDENCE_UNREALIZED:${unrealized.join(',')}`);
  }

  const evidence = selectedEvidence.map((evidenceId) => ({
    evidence_id: evidenceId,
    obligation_ids: supports
      .filter(
        (support) =>
          support.object_id === evidenceId &&
          obligationPropositions.includes(support.proposition_id),
      )
      .map((support) => support.proposition_id.slice('obligation:'.length))
      .sort(),
    artifact_ids: witnessRows
      .filter((row) => row.evidence_id === evidenceId)
      .map((row) => row.artifact_id)
      .sort(),
  }));

  const propertySet = new Set(properties);
  const realizationRoots = [
    ...new Map(
      deriveAssurancePropertyTrustRoots(db)
        .filter((root) => propertySet.has(root.property_id))
        .map(({ property_id: _propertyId, ...root }) => [JSON.stringify(root), root]),
    ).values(),
  ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

  return {
    properties,
    effects,
    obligations,
    evidence,
    realization_roots: realizationRoots,
  };
}

export function assuranceChangePlanFromRelations(
  db: DatabaseSync,
  propertyId: string,
  coordinate: string = ASSURANCE_RELATION_COORDINATE,
  existingSupports: readonly PropositionSupport[] = [],
): AssuranceChangePlan {
  return assuranceChangePlanForPropertiesFromRelations(
    db,
    [propertyId],
    coordinate,
    existingSupports,
  );
}
