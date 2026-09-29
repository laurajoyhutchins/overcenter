import type { DatabaseSync } from 'node:sqlite';

import { deriveAssurancePropertyTrustRoots } from './tcb.ts';

export interface AssuranceChangePlan {
  properties: string[];
  effects: string[];
  obligations: string[];
  evidence: Array<{
    evidence_id: string;
    obligation_ids: string[];
    artifact_ids: string[];
  }>;
  realization_roots: Array<{
    artifact_id: string;
    symbol_id: string;
    basis: 'authority' | 'capability' | 'effect';
    requirement_id: string;
  }>;
}

interface EvidenceRow {
  evidence_id: string;
  obligation_id: string;
  artifact_id: string;
}

function placeholders(values: readonly string[]): string {
  return values.map(() => '?').join(', ');
}

function minimumEvidenceCover(
  obligations: readonly string[],
  rows: readonly EvidenceRow[],
): string[] {
  if (obligations.length === 0) return [];

  const required = new Set(obligations);
  const coverage = new Map<string, Set<string>>();
  for (const row of rows) {
    const covered = coverage.get(row.evidence_id) ?? new Set<string>();
    covered.add(row.obligation_id);
    coverage.set(row.evidence_id, covered);
  }

  const uncovered = obligations.filter(
    (obligation) => ![...coverage.values()].some((covered) => covered.has(obligation)),
  );
  if (uncovered.length > 0) {
    throw new Error(`ASSURANCE_EVIDENCE_INCOMPLETE:${uncovered.join(',')}`);
  }

  const candidates = [...coverage.keys()].sort();
  let best: string[] | null = null;
  const search = (index: number, selected: string[], covered: Set<string>): void => {
    if (best && selected.length >= best.length) return;
    if ([...required].every((obligation) => covered.has(obligation))) {
      best = selected;
      return;
    }
    if (index >= candidates.length) return;

    const evidenceId = candidates[index]!;
    search(
      index + 1,
      [...selected, evidenceId],
      new Set([...covered, ...(coverage.get(evidenceId) ?? [])]),
    );
    search(index + 1, selected, covered);
  };

  search(0, [], new Set());
  if (!best) throw new Error('ASSURANCE_EVIDENCE_INCOMPLETE');
  return best;
}

export function deriveAssuranceChangePlan(
  db: DatabaseSync,
  propertyId: string,
): AssuranceChangePlan {
  const properties = (
    db
      .prepare(`
        WITH RECURSIVE required_property(property_id) AS (
          SELECT property_id
          FROM assurance_property
          WHERE property_id = ?

          UNION

          SELECT composition.required_property_id
          FROM assurance_property_composes_with AS composition
          JOIN required_property AS current
            ON composition.property_id = current.property_id
        )
        SELECT property_id
        FROM required_property
        ORDER BY property_id
      `)
      .all(propertyId) as unknown as Array<{ property_id: string }>
  ).map((row) => row.property_id);
  if (properties.length === 0) throw new Error(`ASSURANCE_PROPERTY_UNKNOWN:${propertyId}`);

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

  const obligations =
    effects.length === 0
      ? []
      : (
          db
            .prepare(`
              SELECT DISTINCT obligation_id
              FROM obligation_guards_effect
              WHERE effect_id IN (${placeholders(effects)})
              ORDER BY obligation_id
            `)
            .all(...effects) as unknown as Array<{ obligation_id: string }>
        ).map((row) => row.obligation_id);

  const evidenceRows =
    obligations.length === 0
      ? []
      : (db
          .prepare(`
            SELECT
              witness.evidence_id,
              witness.obligation_id,
              artifact.artifact_id
            FROM evidence_witnesses_obligation AS witness
            JOIN artifact_witnesses_evidence AS artifact USING(evidence_id)
            WHERE witness.obligation_id IN (${placeholders(obligations)})
            ORDER BY witness.evidence_id, witness.obligation_id, artifact.artifact_id
          `)
          .all(...obligations) as unknown as EvidenceRow[]);

  const selectedEvidence = minimumEvidenceCover(obligations, evidenceRows);
  const evidence = selectedEvidence.map((evidenceId) => {
    const rows = evidenceRows.filter((row) => row.evidence_id === evidenceId);
    return {
      evidence_id: evidenceId,
      obligation_ids: [...new Set(rows.map((row) => row.obligation_id))].sort(),
      artifact_ids: [...new Set(rows.map((row) => row.artifact_id))].sort(),
    };
  });

  const propertySet = new Set(properties);
  const realizationRoots = [
    ...new Map(
      deriveAssurancePropertyTrustRoots(db)
        .filter((root) => propertySet.has(root.property_id))
        .map(({ property_id: _propertyId, ...root }) => [
          JSON.stringify(root),
          root,
        ]),
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
