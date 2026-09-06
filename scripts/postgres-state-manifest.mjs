import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function sha256Parts(parts) {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function tableKey(table) {
  return `${table.schema || 'public'}.${table.name}`;
}

function normalizeExcludedTables(values = []) {
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))].sort();
}

export async function createPostgresStateManifest(db, { excludeTables = [] } = {}) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query is required');

  const excludedTables = normalizeExcludedTables(excludeTables);
  const excluded = new Set(excludedTables);
  const tableResult = await db.query(`
    SELECT table_schema, table_name
      FROM information_schema.tables
     WHERE table_type = 'BASE TABLE'
       AND table_schema = 'public'
     ORDER BY table_schema, table_name
  `);

  const tableRows = [...tableResult.rows]
    .filter(row => !excluded.has(row.table_name))
    .sort((a, b) => `${a.table_schema}.${a.table_name}`.localeCompare(`${b.table_schema}.${b.table_name}`));

  const tables = [];
  for (const row of tableRows) {
    const schema = row.table_schema;
    const name = row.table_name;
    const columnsResult = await db.query(`
      SELECT column_name,
             data_type,
             udt_name,
             is_nullable,
             column_default,
             ordinal_position
        FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = $2
       ORDER BY ordinal_position
    `, [schema, name]);

    const columns = [...columnsResult.rows].sort(
      (a, b) => Number(a.ordinal_position) - Number(b.ordinal_position),
    );
    const schemaSha256 = sha256Parts([JSON.stringify(columns), '\n']);

    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    const rowsResult = await db.query(`
      SELECT row_to_json(t)::text AS row_json
        FROM ${qualified} AS t
       ORDER BY row_to_json(t)::text
    `);
    const canonicalRows = rowsResult.rows
      .map(entry => String(entry.row_json))
      .sort();
    const rowsSha256 = sha256Parts(canonicalRows.map(value => `${value}\n`));

    tables.push({
      schema,
      name,
      schemaSha256,
      rowCount: canonicalRows.length,
      rowsSha256,
    });
  }

  return {
    version: 1,
    excludedTables,
    tables,
  };
}

export function comparePostgresStateManifests(source, target) {
  if (source?.version !== 1 || target?.version !== 1) {
    throw new TypeError('both Postgres state manifests must have version 1');
  }

  const sourceTables = new Map((source.tables || []).map(table => [tableKey(table), table]));
  const targetTables = new Map((target.tables || []).map(table => [tableKey(table), table]));
  const keys = [...new Set([...sourceTables.keys(), ...targetTables.keys()])].sort();
  const differences = [];

  for (const key of keys) {
    const sourceTable = sourceTables.get(key);
    const targetTable = targetTables.get(key);
    const table = sourceTable?.name || targetTable?.name || key;

    if (!sourceTable || !targetTable) {
      differences.push({
        table,
        field: 'presence',
        source: Boolean(sourceTable),
        target: Boolean(targetTable),
      });
      continue;
    }

    for (const field of ['schemaSha256', 'rowCount', 'rowsSha256']) {
      if (sourceTable[field] !== targetTable[field]) {
        differences.push({
          table,
          field,
          source: sourceTable[field],
          target: targetTable[field],
        });
      }
    }
  }

  return { ok: differences.length === 0, differences };
}

async function runCli() {
  const args = process.argv.slice(2);
  if (args[0] === '--compare') {
    if (args.length !== 3) {
      throw new Error('usage: node scripts/postgres-state-manifest.mjs --compare SOURCE.json TARGET.json');
    }
    const [source, target] = await Promise.all(
      args.slice(1).map(async path => JSON.parse(await readFile(path, 'utf8'))),
    );
    const comparison = comparePostgresStateManifests(source, target);
    process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    if (!comparison.ok) process.exitCode = 1;
    return;
  }

  const { default: pg } = await import('pg');
  const { Pool } = pg;
  const pool = new Pool();
  const excludeTables = normalizeExcludedTables(
    (process.env.OVERCENTER_MANIFEST_EXCLUDE || '').split(','),
  );

  try {
    const manifest = await createPostgresStateManifest(pool, { excludeTables });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  runCli().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
