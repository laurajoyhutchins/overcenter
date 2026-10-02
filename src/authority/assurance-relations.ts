import type { DatabaseSync } from 'node:sqlite';

import type { AssuranceChangePlan } from '../architecture/change-planner.ts';
import { deriveAssurancePropertyTrustRoots } from '../architecture/tcb.ts';

export const ASSURANCE_RELATION_COORDINATE = 'architecture/current' as const;

export interface PropositionSupport {
  object_id: string;
  proposition_id: string;
  coordinate: string;
}

interface EvidenceArtifactRow {
  evidence_id: string;
  artifact_id: string;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

export function minimumSupportCover(
  propositions: readonly string[],
  rows: readonly PropositionSupport[],
  coordinate: string,
): string[] {
  if (propositions.length === 0) return [];

  const required = new Set(propositions);
  const coverage = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.coordinate !== coordinate || !required.has(row.proposition_id)) continue;
    const covered = coverage.get(row.object_id) ?? new Set<string>();
    covered.add(row.proposition_id);
    coverage.set(row.object_id, covered);
  }

  const uncovered = propositions.filter(
    (proposition) => ![...coverage.values()].some((covered) => covered.has(proposition)),
  );
  if (uncovered.length > 0) {
    throw new Error(`ASSURANCE_SUPPORT_INCOMPLETE:${uncovered.join(',')}`);
  }

  const candidates = [...coverage.keys()].sort();
  let best: string[] | null = null;
  const search = (index: number, selected: string[], covered: Set<string>): void => {
    if (best && selected.length >= best.length) return;
    if ([...required].every((proposition) => covered.has(proposition))) {
      best = selected;
      return;
    }
    if (index >= candidates.length) return;

    const objectId = candidates[index]!;
    search(
      index + 1,
      [...selected, objectId],
      new Set([...covered, ...(coverage.get(objectId) ?? [])]),
    );
    search(index + 1, selected, covered);
  };

  search(0, [], new Set());
  if (!best) throw new Error('ASSURANCE_SUPPORT_INCOMPLETE');
  return best;
}

export function assuranceChangePlanFromRelations(
  db: DatabaseSync,
  propertyId: string,
  coordinate = ASSURANCE_RELATION_COORDINATE,
): AssuranceChangePlan {
  const known = db
    .prepare('SELECT property_id FROM assurance_property WHERE property_id = ?')
    .get(propertyId) as { property_id: string } | undefined;
  if (!known) throw new Error(`ASSURANCE_PROPERTY_UNKNOWN:${propertyId}`);

  const closure = (
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
            'property:' || property_id,
            'proof:' || property_id || ':' || evidence_id
          FROM evidence_witnesses_assurance_property
        ),
        closure(proposition_id) AS (
          SELECT 'property:' || ?

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
      .all(propertyId) as unknown as Array<{ proposition_id: string }>
  ).map((row) => row.proposition_id);

  const properties = closure
    .filter((proposition) => proposition.startsWith('property:'))
    .map((proposition) => proposition.slice('property:'.length));
  const obligationPropositions = closure.filter((proposition) =>
    proposition.startsWith('obligation:'),
  );
  const obligations = obligationPropositions.map((proposition) =>
    proposition.slice('obligation:'.length),
  );
  const proofPropositions = closure.filter((proposition) => proposition.startsWith('proof:'));

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

  const supports = db
    .prepare(`
      SELECT
        evidence_id AS object_id,
        'obligation:' || obligation_id AS proposition_id,
        ? AS coordinate
      FROM evidence_witnesses_obligation

      UNION ALL

      SELECT
        evidence_id AS object_id,
        'proof:' || property_id || ':' || evidence_id AS proposition_id,
        ? AS coordinate
      FROM evidence_witnesses_assurance_property

      ORDER BY object_id, proposition_id
    `)
    .all(coordinate, coordinate) as unknown as PropositionSupport[];

  const selectedEvidence = [
    ...new Set([
      ...minimumSupportCover(obligationPropositions, supports, coordinate),
      ...minimumSupportCover(proofPropositions, supports, coordinate),
    ]),
  ].sort();

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

// Immutable-base compatibility only; both names execute the same relational planner.
export const shadowAssuranceChangePlan = assuranceChangePlanFromRelations;
