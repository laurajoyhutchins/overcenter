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


export interface AssurancePropertyImpact {
  property_id: string;
  changed_artifacts: string[];
  direct: boolean;
  via_properties: string[];
}

export type ArtifactDependencyClosure = (rootArtifacts: readonly string[]) => readonly string[];

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


export function deriveAffectedAssuranceProperties(
  db: DatabaseSync,
  changedArtifacts: readonly string[],
  dependencyClosure: ArtifactDependencyClosure,
): AssurancePropertyImpact[] {
  const changed = new Set(changedArtifacts);
  if (changed.size === 0) return [];

  const rootsByProperty = new Map<string, Set<string>>();
  for (const root of deriveAssurancePropertyTrustRoots(db)) {
    const roots = rootsByProperty.get(root.property_id) ?? new Set<string>();
    roots.add(root.artifact_id);
    rootsByProperty.set(root.property_id, roots);
  }

  const direct = new Map<string, string[]>();
  for (const [propertyId, rootArtifacts] of rootsByProperty) {
    const closure = new Set(dependencyClosure([...rootArtifacts].sort()));
    const affected = [...changed].filter((artifact) => closure.has(artifact)).sort();
    if (affected.length > 0) direct.set(propertyId, affected);
  }

  const compositions = db
    .prepare(`
      SELECT property_id, required_property_id
      FROM assurance_property_composes_with
      ORDER BY property_id, required_property_id
    `)
    .all() as unknown as Array<{ property_id: string; required_property_id: string }>;

  const affected = new Map<
    string,
    { changedArtifacts: Set<string>; direct: boolean; viaProperties: Set<string> }
  >();
  for (const [propertyId, artifacts] of direct) {
    affected.set(propertyId, {
      changedArtifacts: new Set(artifacts),
      direct: true,
      viaProperties: new Set(),
    });
  }

  let changedImpact = true;
  while (changedImpact) {
    changedImpact = false;
    for (const composition of compositions) {
      const required = affected.get(composition.required_property_id);
      if (!required) continue;

      const current = affected.get(composition.property_id) ?? {
        changedArtifacts: new Set<string>(),
        direct: false,
        viaProperties: new Set<string>(),
      };
      const beforeArtifacts = current.changedArtifacts.size;
      const beforeVia = current.viaProperties.size;
      for (const artifact of required.changedArtifacts) current.changedArtifacts.add(artifact);
      current.viaProperties.add(composition.required_property_id);
      affected.set(composition.property_id, current);
      if (
        current.changedArtifacts.size !== beforeArtifacts ||
        current.viaProperties.size !== beforeVia
      ) {
        changedImpact = true;
      }
    }
  }

  return [...affected.entries()]
    .map(([property_id, impact]) => ({
      property_id,
      changed_artifacts: [...impact.changedArtifacts].sort(),
      direct: impact.direct,
      via_properties: [...impact.viaProperties].sort(),
    }))
    .sort((left, right) => left.property_id.localeCompare(right.property_id));
}
