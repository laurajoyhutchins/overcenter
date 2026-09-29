import type { DatabaseSync } from 'node:sqlite';

export interface ObservedArchitecture {
  source_revision: string;
  artifacts: Array<{ artifact_id: string }>;
  symbols: Array<{ symbol_id: string; artifact_id: string }>;
  principals: Array<{ principal_id: string }>;
  principal_capabilities: Array<{ principal_id: string; capability_id: string }>;
  principal_invocations: Array<{ principal_id: string; effect_id: string }>;
  principal_reachability: Array<{ principal_id: string; effect_id: string }>;
  unresolved_effect_calls: Array<{
    principal_id: string;
    call_site_path: string;
    call_site_line: number;
    call_expression_sha256: string;
    candidate_effects: string[];
  }>;
}

export const ARCHITECTURE_RECONCILIATION_SCHEMA =
  'overcenter-relational-architecture-reconciliation/v1' as const;

export type ArchitectureFindingState = 'missing' | 'unexpected' | 'unknown';

export interface ArchitectureFinding {
  state: ArchitectureFindingState;
  relation: string;
  key: Record<string, string | number | string[]>;
}

export interface ArchitectureReconciliation {
  schema: typeof ARCHITECTURE_RECONCILIATION_SCHEMA;
  source_revision: string;
  findings: ArchitectureFinding[];
}

interface OneColumnRow {
  value: string;
}

interface TwoColumnRow {
  left_value: string;
  right_value: string;
}

function observedSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TEMP TABLE observed_artifact (
      artifact_id TEXT PRIMARY KEY
    ) STRICT;

    CREATE TEMP TABLE observed_symbol (
      symbol_id TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      PRIMARY KEY (symbol_id, artifact_id)
    ) STRICT;

    CREATE TEMP TABLE observed_principal (
      principal_id TEXT PRIMARY KEY
    ) STRICT;

    CREATE TEMP TABLE observed_principal_capability (
      principal_id TEXT NOT NULL,
      capability_id TEXT NOT NULL,
      PRIMARY KEY (principal_id, capability_id)
    ) STRICT;

    CREATE TEMP TABLE observed_principal_invokes_effect (
      principal_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      PRIMARY KEY (principal_id, effect_id)
    ) STRICT;

    CREATE TEMP TABLE observed_principal_reaches_effect (
      principal_id TEXT NOT NULL,
      effect_id TEXT NOT NULL,
      PRIMARY KEY (principal_id, effect_id)
    ) STRICT;

    CREATE TEMP TABLE observed_unresolved_effect_call (
      principal_id TEXT NOT NULL,
      call_site_path TEXT NOT NULL,
      call_site_line INTEGER NOT NULL,
      call_expression_sha256 TEXT NOT NULL,
      candidate_effects_json TEXT NOT NULL,
      PRIMARY KEY (
        principal_id,
        call_site_path,
        call_site_line,
        call_expression_sha256
      )
    ) STRICT;
  `);
}

function insertObserved(db: DatabaseSync, observed: ObservedArchitecture): void {
  const artifact = db.prepare('INSERT INTO observed_artifact(artifact_id) VALUES (?)');
  for (const row of observed.artifacts) artifact.run(row.artifact_id);

  const symbol = db.prepare('INSERT INTO observed_symbol(symbol_id, artifact_id) VALUES (?, ?)');
  for (const row of observed.symbols) symbol.run(row.symbol_id, row.artifact_id);

  const principal = db.prepare('INSERT INTO observed_principal(principal_id) VALUES (?)');
  for (const row of observed.principals) principal.run(row.principal_id);

  const capability = db.prepare(
    'INSERT INTO observed_principal_capability(principal_id, capability_id) VALUES (?, ?)',
  );
  for (const row of observed.principal_capabilities) {
    capability.run(row.principal_id, row.capability_id);
  }

  const invocation = db.prepare(
    'INSERT INTO observed_principal_invokes_effect(principal_id, effect_id) VALUES (?, ?)',
  );
  for (const row of observed.principal_invocations) {
    invocation.run(row.principal_id, row.effect_id);
  }

  const reachability = db.prepare(
    'INSERT INTO observed_principal_reaches_effect(principal_id, effect_id) VALUES (?, ?)',
  );
  for (const row of observed.principal_reachability) {
    reachability.run(row.principal_id, row.effect_id);
  }

  const unresolved = db.prepare(`
    INSERT INTO observed_unresolved_effect_call(
      principal_id,
      call_site_path,
      call_site_line,
      call_expression_sha256,
      candidate_effects_json
    ) VALUES (?, ?, ?, ?, ?)
  `);
  for (const row of observed.unresolved_effect_calls) {
    unresolved.run(
      row.principal_id,
      row.call_site_path,
      row.call_site_line,
      row.call_expression_sha256,
      JSON.stringify(row.candidate_effects),
    );
  }
}

function oneColumnFindings(
  db: DatabaseSync,
  state: Exclude<ArchitectureFindingState, 'unknown'>,
  relation: string,
  key: string,
  query: string,
): ArchitectureFinding[] {
  return (db.prepare(query).all() as unknown as OneColumnRow[]).map((row) => ({
    state,
    relation,
    key: { [key]: row.value },
  }));
}

function twoColumnFindings(
  db: DatabaseSync,
  state: Exclude<ArchitectureFindingState, 'unknown'>,
  relation: string,
  leftKey: string,
  rightKey: string,
  query: string,
): ArchitectureFinding[] {
  return (db.prepare(query).all() as unknown as TwoColumnRow[]).map((row) => ({
    state,
    relation,
    key: {
      [leftKey]: row.left_value,
      [rightKey]: row.right_value,
    },
  }));
}

function modelFindings(db: DatabaseSync): ArchitectureFinding[] {
  return [
    ...oneColumnFindings(
      db,
      'missing',
      'authority_implementation',
      'authority_id',
      `
        SELECT authority_id AS value
        FROM authority
        EXCEPT
        SELECT DISTINCT authority_id AS value
        FROM symbol_implements_authority
        ORDER BY value
      `,
    ),
    ...oneColumnFindings(
      db,
      'missing',
      'obligation_evidence',
      'obligation_id',
      `
        SELECT obligation_id AS value
        FROM obligation
        EXCEPT
        SELECT DISTINCT obligation_id AS value
        FROM evidence_witnesses_obligation
        ORDER BY value
      `,
    ),
    ...oneColumnFindings(
      db,
      'missing',
      'evidence_witness',
      'evidence_id',
      `
        SELECT evidence_id AS value
        FROM evidence
        EXCEPT
        SELECT DISTINCT evidence_id AS value
        FROM artifact_witnesses_evidence
        ORDER BY value
      `,
    ),
  ];
}

function physicalFindings(db: DatabaseSync): ArchitectureFinding[] {
  return [
    ...oneColumnFindings(
      db,
      'missing',
      'artifact',
      'artifact_id',
      `
        SELECT artifact_id AS value FROM artifact
        EXCEPT
        SELECT artifact_id AS value FROM observed_artifact
        ORDER BY value
      `,
    ),
    ...twoColumnFindings(
      db,
      'missing',
      'symbol',
      'symbol_id',
      'artifact_id',
      `
        SELECT symbol_id AS left_value, artifact_id AS right_value FROM symbol
        EXCEPT
        SELECT symbol_id AS left_value, artifact_id AS right_value FROM observed_symbol
        ORDER BY left_value, right_value
      `,
    ),
    ...oneColumnFindings(
      db,
      'missing',
      'principal',
      'principal_id',
      `
        SELECT principal_id AS value FROM principal
        EXCEPT
        SELECT principal_id AS value FROM observed_principal
        ORDER BY value
      `,
    ),
    ...twoColumnFindings(
      db,
      'missing',
      'principal_has_capability',
      'principal_id',
      'capability_id',
      `
        SELECT principal_id AS left_value, capability_id AS right_value
        FROM principal_has_capability
        EXCEPT
        SELECT principal_id AS left_value, capability_id AS right_value
        FROM observed_principal_capability
        ORDER BY left_value, right_value
      `,
    ),
    ...twoColumnFindings(
      db,
      'unexpected',
      'principal_has_capability',
      'principal_id',
      'capability_id',
      `
        SELECT principal_id AS left_value, capability_id AS right_value
        FROM observed_principal_capability
        EXCEPT
        SELECT principal_id AS left_value, capability_id AS right_value
        FROM principal_has_capability
        ORDER BY left_value, right_value
      `,
    ),
    ...twoColumnFindings(
      db,
      'missing',
      'principal_invokes_effect',
      'principal_id',
      'effect_id',
      `
        SELECT principal_id AS left_value, effect_id AS right_value
        FROM principal_invokes_effect
        EXCEPT
        SELECT principal_id AS left_value, effect_id AS right_value
        FROM observed_principal_invokes_effect
        ORDER BY left_value, right_value
      `,
    ),
    ...twoColumnFindings(
      db,
      'unexpected',
      'principal_invokes_effect',
      'principal_id',
      'effect_id',
      `
        SELECT principal_id AS left_value, effect_id AS right_value
        FROM observed_principal_invokes_effect
        EXCEPT
        SELECT principal_id AS left_value, effect_id AS right_value
        FROM principal_invokes_effect
        ORDER BY left_value, right_value
      `,
    ),
    ...twoColumnFindings(
      db,
      'missing',
      'principal_reaches_effect',
      'principal_id',
      'effect_id',
      `
        SELECT principal_id AS left_value, effect_id AS right_value
        FROM principal_reaches_effect
        EXCEPT
        SELECT principal_id AS left_value, effect_id AS right_value
        FROM observed_principal_reaches_effect
        ORDER BY left_value, right_value
      `,
    ),
    ...twoColumnFindings(
      db,
      'unexpected',
      'principal_reaches_effect',
      'principal_id',
      'effect_id',
      `
        SELECT principal_id AS left_value, effect_id AS right_value
        FROM observed_principal_reaches_effect
        EXCEPT
        SELECT principal_id AS left_value, effect_id AS right_value
        FROM principal_reaches_effect
        ORDER BY left_value, right_value
      `,
    ),
  ];
}

function unknownFindings(db: DatabaseSync): ArchitectureFinding[] {
  const rows = db
    .prepare(`
      SELECT
        principal_id,
        call_site_path,
        call_site_line,
        call_expression_sha256,
        candidate_effects_json
      FROM observed_unresolved_effect_call
      ORDER BY principal_id, call_site_path, call_site_line, call_expression_sha256
    `)
    .all() as unknown as Array<{
    principal_id: string;
    call_site_path: string;
    call_site_line: number | bigint;
    call_expression_sha256: string;
    candidate_effects_json: string;
  }>;

  return rows.map((row) => ({
    state: 'unknown',
    relation: 'principal_reaches_effect',
    key: {
      principal_id: row.principal_id,
      call_site_path: row.call_site_path,
      call_site_line: Number(row.call_site_line),
      call_expression_sha256: row.call_expression_sha256,
      candidate_effects: JSON.parse(row.candidate_effects_json) as string[],
    },
  }));
}

export function reconcileArchitecture(
  db: DatabaseSync,
  observed: ObservedArchitecture,
): ArchitectureReconciliation {
  observedSchema(db);
  insertObserved(db, observed);
  const findings = [...modelFindings(db), ...physicalFindings(db), ...unknownFindings(db)].sort(
    (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return {
    schema: ARCHITECTURE_RECONCILIATION_SCHEMA,
    source_revision: observed.source_revision,
    findings,
  };
}
