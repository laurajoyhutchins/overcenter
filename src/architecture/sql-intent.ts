import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import {
  ARCHITECTURE_INTENT_SCHEMA,
  type ArchitectureIntent,
  validateArchitectureIntent,
} from '../authority/architecture-reconciliation.ts';

export const ARCHITECTURE_SQL_PATH = 'architecture.sql' as const;

interface MetadataRow {
  schema: string;
}

interface ClaimRow {
  concept: string;
  kind: string;
}

interface AuthorityRow {
  authority_path: string;
}

interface PathRow {
  path: string;
}

interface GrantRow {
  workflow: string;
  value: string;
}

function paths(db: DatabaseSync, table: string, concept: string): string[] {
  return (
    db
      .prepare(`SELECT path FROM ${table} WHERE concept = ? ORDER BY path`)
      .all(concept) as unknown as PathRow[]
  ).map((row) => row.path);
}

function grants(
  db: DatabaseSync,
  table: string,
  valueColumn: string,
  concept: string,
): Array<{ workflow: string; values: string[] }> {
  const rows = db
    .prepare(
      `SELECT workflow, ${valueColumn} AS value
       FROM ${table}
       WHERE concept = ?
       ORDER BY workflow, ${valueColumn}`,
    )
    .all(concept) as unknown as GrantRow[];

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const values = grouped.get(row.workflow) ?? [];
    values.push(row.value);
    grouped.set(row.workflow, values);
  }
  return [...grouped].map(([workflow, values]) => ({ workflow, values }));
}

export function loadArchitectureIntent(path = ARCHITECTURE_SQL_PATH): ArchitectureIntent {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(readFileSync(path, 'utf8'));

    const metadata = db
      .prepare('SELECT schema FROM architecture_metadata WHERE singleton = 1')
      .get() as MetadataRow | undefined;
    if (metadata?.schema !== ARCHITECTURE_INTENT_SCHEMA) {
      throw new Error('ARCHITECTURE_SQL_SCHEMA_UNSUPPORTED');
    }

    const rows = db
      .prepare('SELECT concept, kind FROM architecture_claim ORDER BY concept')
      .all() as unknown as ClaimRow[];

    const claims = rows.map((row): unknown => {
      if (row.kind === 'authority-role') {
        const authority = db
          .prepare('SELECT authority_path FROM authority_role WHERE concept = ?')
          .get(row.concept) as AuthorityRow | undefined;
        if (!authority) throw new Error(`ARCHITECTURE_SQL_AUTHORITY_ROLE_MISSING:${row.concept}`);
        return {
          kind: row.kind,
          concept: row.concept,
          authority: authority.authority_path,
          projections: paths(db, 'authority_projection', row.concept),
          verifiers: paths(db, 'authority_verifier', row.concept),
        };
      }

      if (row.kind === 'github-actions-explicit-write-authority') {
        return {
          kind: row.kind,
          concept: row.concept,
          allowed: grants(db, 'github_actions_explicit_write', 'permission', row.concept).map(
            ({ workflow, values }) => ({ workflow, permissions: values }),
          ),
        };
      }

      if (row.kind === 'github-actions-provider-effect-authority') {
        return {
          kind: row.kind,
          concept: row.concept,
          allowed: grants(db, 'github_actions_provider_effect', 'effect', row.concept).map(
            ({ workflow, values }) => ({ workflow, effects: values }),
          ),
        };
      }

      if (row.kind === 'workflow-transitive-effect-authority') {
        return {
          kind: row.kind,
          concept: row.concept,
          allowed: grants(db, 'workflow_transitive_effect', 'effect', row.concept).map(
            ({ workflow, values }) => ({ workflow, effects: values }),
          ),
        };
      }

      throw new Error(`ARCHITECTURE_SQL_CLAIM_KIND_UNSUPPORTED:${row.kind}`);
    });

    return validateArchitectureIntent({
      schema: metadata.schema,
      claims,
    });
  } finally {
    db.close();
  }
}
