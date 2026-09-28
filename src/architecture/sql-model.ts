import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  type ArchitectureIntent,
  validateArchitectureIntent,
} from '../authority/architecture-reconciliation.ts';

export const ARCHITECTURE_SQL_PATHS = [
  'architecture/concepts.sql',
  'architecture/logic.sql',
  'architecture/physics.sql',
] as const;

interface CapabilityImplementationRow {
  capability_id: string;
  artifact_id: string;
}

interface ArtifactRow {
  artifact_id: string;
}

interface WorkflowCapabilityRow {
  workflow: string;
  capability_id: string;
}

interface WorkflowEffectRow {
  workflow: string;
  effect_id: string;
}

function architectureDatabase(root: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const path of ARCHITECTURE_SQL_PATHS) {
      db.exec(readFileSync(resolve(root, path), 'utf8'));
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error('ARCHITECTURE_FOREIGN_KEY_VIOLATION');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function capabilityClaims(db: DatabaseSync): unknown[] {
  const rows = db
    .prepare(`
      SELECT DISTINCT sic.capability_id, s.artifact_id
      FROM symbol_implements_capability sic
      JOIN symbol s USING(symbol_id)
      ORDER BY sic.capability_id, s.artifact_id
    `)
    .all() as unknown as CapabilityImplementationRow[];

  const artifactsByCapability = new Map<string, string[]>();
  for (const row of rows) {
    const artifacts = artifactsByCapability.get(row.capability_id) ?? [];
    if (!artifacts.includes(row.artifact_id)) artifacts.push(row.artifact_id);
    artifactsByCapability.set(row.capability_id, artifacts);
  }

  return [...artifactsByCapability].map(([capability, artifacts]) => {
    if (artifacts.length !== 1) {
      throw new Error(`ARCHITECTURE_COMPATIBILITY_IMPLEMENTATION_AMBIGUOUS:${capability}`);
    }
    const authority = artifacts[0]!;
    const projections = (
      db
        .prepare(`
          SELECT DISTINCT s.artifact_id
          FROM symbol_projects_capability spc
          JOIN symbol s USING(symbol_id)
          WHERE spc.capability_id = ?
            AND s.artifact_id <> ?
          ORDER BY s.artifact_id
        `)
        .all(capability, authority) as unknown as ArtifactRow[]
    ).map((row) => row.artifact_id);
    const verifiers = (
      db
        .prepare(`
          SELECT DISTINCT awe.artifact_id
          FROM evidence_witnesses_capability ewc
          JOIN artifact_witnesses_evidence awe USING(evidence_id)
          WHERE ewc.capability_id = ?
          ORDER BY awe.artifact_id
        `)
        .all(capability) as unknown as ArtifactRow[]
    ).map((row) => row.artifact_id);

    return {
      kind: 'authority-role',
      concept: capability,
      authority,
      projections,
      verifiers,
    };
  });
}

function workflowCapabilityClaim(db: DatabaseSync): unknown {
  const prefix = 'github-actions/permission/';
  const suffix = '/write';
  const rows = db
    .prepare(`
      SELECT DISTINCT pda.artifact_id AS workflow, phc.capability_id
      FROM principal_has_capability phc
      JOIN principal_defined_in_artifact pda USING(principal_id)
      WHERE phc.capability_id LIKE 'github-actions/permission/%/write'
      ORDER BY pda.artifact_id, phc.capability_id
    `)
    .all() as unknown as WorkflowCapabilityRow[];
  const allowed = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.capability_id.startsWith(prefix) || !row.capability_id.endsWith(suffix)) continue;
    const permission = row.capability_id.slice(prefix.length, -suffix.length);
    const permissions = allowed.get(row.workflow) ?? [];
    if (!permissions.includes(permission)) permissions.push(permission);
    allowed.set(row.workflow, permissions);
  }
  return {
    kind: 'github-actions-explicit-write-authority',
    concept: 'github-actions-explicit-write-capability',
    allowed: [...allowed].map(([workflow, permissions]) => ({
      workflow,
      permissions: permissions.sort(),
    })),
  };
}

function workflowEffectClaim(
  db: DatabaseSync,
  table: 'principal_invokes_effect' | 'principal_reaches_effect',
  kind: 'github-actions-provider-effect-authority' | 'workflow-transitive-effect-authority',
  concept: string,
): unknown {
  const rows = db
    .prepare(`
      SELECT DISTINCT pda.artifact_id AS workflow, pe.effect_id
      FROM ${table} pe
      JOIN principal_defined_in_artifact pda USING(principal_id)
      ORDER BY pda.artifact_id, pe.effect_id
    `)
    .all() as unknown as WorkflowEffectRow[];
  const allowed = new Map<string, string[]>();
  for (const row of rows) {
    const effects = allowed.get(row.workflow) ?? [];
    if (!effects.includes(row.effect_id)) effects.push(row.effect_id);
    allowed.set(row.workflow, effects);
  }
  return {
    kind,
    concept,
    allowed: [...allowed].map(([workflow, effects]) => ({
      workflow,
      effects: effects.sort(),
    })),
  };
}

export function loadArchitectureIntent(root = process.cwd()): ArchitectureIntent {
  const db = architectureDatabase(root);
  try {
    return validateArchitectureIntent({
      schema: 'overcenter-architecture-intent/v1',
      claims: [
        ...capabilityClaims(db),
        workflowCapabilityClaim(db),
        workflowEffectClaim(
          db,
          'principal_invokes_effect',
          'github-actions-provider-effect-authority',
          'github-actions-direct-provider-effects',
        ),
        workflowEffectClaim(
          db,
          'principal_reaches_effect',
          'workflow-transitive-effect-authority',
          'workflow-transitive-provider-effects',
        ),
      ],
    });
  } finally {
    db.close();
  }
}
