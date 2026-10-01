import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import { deriveAssurancePropertyTrustRoots } from './tcb.ts';

interface EvidencePropertyRow {
  evidence_id: string;
  property_id: string;
}

export interface EvidenceInvalidation {
  evidence_id: string;
  property_ids: string[];
  changed_artifacts: string[];
}

export interface AssurancePropertyImpact {
  property_id: string;
  changed_artifacts: string[];
  direct: boolean;
  via_properties: string[];
}

export type ArtifactDependencyClosure = (rootArtifacts: readonly string[]) => readonly string[];

export interface EvidenceInvalidationOptions {
  base_package?: Record<string, unknown> | undefined;
  head_package?: Record<string, unknown> | undefined;
}

const PACKAGE_RUNTIME_KEYS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'engines',
  'packageManager',
  'type',
]);

const PACKAGE_METADATA_KEYS = new Set(['name', 'private', 'version', 'description', 'license']);

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !isDeepStrictEqual(before[key], after[key]))
    .sort();
}

function runtimeEvidenceIds(db: DatabaseSync): string[] {
  return (
    db
      .prepare('SELECT evidence_id FROM evidence_uses_package_runtime ORDER BY evidence_id')
      .all() as unknown as Array<{
      evidence_id: string;
    }>
  ).map((row) => row.evidence_id);
}

function scriptEvidenceIds(db: DatabaseSync, scriptNames: readonly string[]): string[] {
  if (scriptNames.length === 0) return [];
  return (
    db
      .prepare(`
        SELECT DISTINCT evidence_id
        FROM evidence_uses_package_script
        WHERE script_name IN (${placeholders(scriptNames)})
        ORDER BY evidence_id
      `)
      .all(...scriptNames) as unknown as Array<{ evidence_id: string }>
  ).map((row) => row.evidence_id);
}

function packageEvidenceIds(
  db: DatabaseSync,
  basePackage?: Record<string, unknown>,
  headPackage?: Record<string, unknown>,
): string[] {
  const allRuntimeEvidence = runtimeEvidenceIds(db);
  if (!basePackage || !headPackage) return allRuntimeEvidence;

  const topLevel = changedKeys(basePackage, headPackage);
  if (topLevel.some((key) => PACKAGE_RUNTIME_KEYS.has(key))) return allRuntimeEvidence;

  const unknown = topLevel.filter((key) => key !== 'scripts' && !PACKAGE_METADATA_KEYS.has(key));
  if (unknown.length > 0) return allRuntimeEvidence;
  if (!topLevel.includes('scripts')) return [];

  const beforeScripts = objectValue(basePackage.scripts);
  const afterScripts = objectValue(headPackage.scripts);
  if (!beforeScripts || !afterScripts) return allRuntimeEvidence;

  return scriptEvidenceIds(db, changedKeys(beforeScripts, afterScripts));
}

export function deriveInvalidatedEvidence(
  db: DatabaseSync,
  changedArtifacts: readonly string[],
  options: EvidenceInvalidationOptions = {},
): EvidenceInvalidation[] {
  const changed = [...new Set(changedArtifacts)].sort();
  if (changed.length === 0) return [];

  const invalidatedByEvidence = new Map<string, Set<string>>();
  const ordinary = changed.filter((artifact) => artifact !== 'package.json');

  if (ordinary.length > 0) {
    const rows = db
      .prepare(`
        SELECT evidence_id, artifact_id
        FROM (
          SELECT evidence_id, artifact_id
          FROM evidence_depends_on_artifact
          UNION
          SELECT evidence_id, artifact_id
          FROM artifact_witnesses_evidence
        )
        WHERE artifact_id IN (${placeholders(ordinary)})
        ORDER BY evidence_id, artifact_id
      `)
      .all(...ordinary) as unknown as Array<{ evidence_id: string; artifact_id: string }>;

    for (const row of rows) {
      const artifacts = invalidatedByEvidence.get(row.evidence_id) ?? new Set<string>();
      artifacts.add(row.artifact_id);
      invalidatedByEvidence.set(row.evidence_id, artifacts);
    }
  }

  if (changed.includes('package.json')) {
    for (const evidenceId of packageEvidenceIds(db, options.base_package, options.head_package)) {
      const artifacts = invalidatedByEvidence.get(evidenceId) ?? new Set<string>();
      artifacts.add('package.json');
      invalidatedByEvidence.set(evidenceId, artifacts);
    }
  }

  const evidenceIds = [...invalidatedByEvidence.keys()].sort();
  if (evidenceIds.length === 0) return [];

  const propertyRows = db
    .prepare(`
      SELECT evidence_id, property_id
      FROM evidence_witnesses_assurance_property
      WHERE evidence_id IN (${placeholders(evidenceIds)})
      ORDER BY evidence_id, property_id
    `)
    .all(...evidenceIds) as unknown as EvidencePropertyRow[];

  const propertiesByEvidence = new Map<string, string[]>();
  for (const row of propertyRows) {
    const properties = propertiesByEvidence.get(row.evidence_id) ?? [];
    properties.push(row.property_id);
    propertiesByEvidence.set(row.evidence_id, properties);
  }

  return evidenceIds.map((evidence_id) => ({
    evidence_id,
    property_ids: [...new Set(propertiesByEvidence.get(evidence_id) ?? [])].sort(),
    changed_artifacts: [...(invalidatedByEvidence.get(evidence_id) ?? [])].sort(),
  }));
}

export function deriveAffectedAssuranceProperties(
  db: DatabaseSync,
  changedArtifacts: readonly string[],
  dependencyClosure: ArtifactDependencyClosure,
  options: EvidenceInvalidationOptions = {},
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

  for (const invalidation of deriveInvalidatedEvidence(db, [...changed], options)) {
    for (const propertyId of invalidation.property_ids) {
      direct.set(
        propertyId,
        [...new Set([...(direct.get(propertyId) ?? []), ...invalidation.changed_artifacts])].sort(),
      );
    }
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
