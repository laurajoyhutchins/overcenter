import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { fingerprintStructure, sourceIdentity } from '../canonical.mjs';

const { Client } = pg;
const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema'];

function candidate(path, anchor, structure) {
  return {
    source_identity:sourceIdentity('postgres', path, anchor),
    source_kind:'postgres',
    source_location:{ path, anchor },
    symbol_or_boundary:anchor,
    structural_fingerprint:fingerprintStructure(structure),
    structure,
    observed_relationships:[],
  };
}

export async function applyMigrations(client, migrationsDir) {
  const entries = (await readdir(migrationsDir, { withFileTypes:true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(migrationsDir, entry.name);
    const sql = await readFile(path, 'utf8');
    if (!sql.trim()) continue;
    try {
      await client.query(sql);
    } catch (cause) {
      const error = new Error(`contract database migration failed: ${entry.name}`, { cause });
      Object.assign(error, { code:'CONTRACT_DATABASE_MIGRATION_FAILED', migration:entry.name });
      throw error;
    }
  }
}

async function rows(client, sql) {
  try {
    return (await client.query(sql)).rows;
  } catch (cause) {
    const error = new Error('contract database introspection failed', { cause });
    Object.assign(error, { code:'CONTRACT_DATABASE_INTROSPECTION_FAILED' });
    throw error;
  }
}

export async function introspectPostgresContracts(client) {
  const candidates = [];
  const tables = await rows(client, `
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND table_type = 'BASE TABLE'
    ORDER BY table_schema, table_name
  `);
  for (const table of tables) {
    candidates.push(candidate(`${table.table_schema}.${table.table_name}`, 'table', { kind:'table' }));
  }

  const views = await rows(client, `
    SELECT schemaname AS table_schema, viewname AS table_name, definition
    FROM pg_views
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY schemaname, viewname
  `);
  for (const view of views) {
    candidates.push(candidate(`${view.table_schema}.${view.table_name}`, 'view', {
      kind:'view',
      definition:String(view.definition || '').trim(),
    }));
  }

  const columns = await rows(client, `
    SELECT table_schema, table_name, column_name, data_type, udt_schema, udt_name,
           is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name, ordinal_position
  `);
  for (const column of columns) {
    candidates.push(candidate(`${column.table_schema}.${column.table_name}`, column.column_name, {
      kind:'column',
      data_type:column.data_type === 'USER-DEFINED' ? column.udt_name : column.data_type,
      udt_schema:column.udt_schema,
      udt_name:column.udt_name,
      nullable:column.is_nullable === 'YES',
      default:column.column_default,
    }));
  }

  const types = await rows(client, `
    SELECT n.nspname AS schema_name,
           t.typname AS type_name,
           t.typtype AS type_kind,
           format_type(t.typbasetype, t.typtypmod) AS domain_base,
           COALESCE(
             json_agg(e.enumlabel ORDER BY e.enumsortorder) FILTER (WHERE e.enumlabel IS NOT NULL),
             '[]'::json
           ) AS enum_values
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    LEFT JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND t.typtype IN ('e', 'd')
    GROUP BY n.nspname, t.typname, t.typtype, t.typbasetype, t.typtypmod
    ORDER BY n.nspname, t.typname
  `);
  for (const type of types) {
    candidates.push(candidate(`${type.schema_name}.${type.type_name}`, 'type', {
      kind:type.type_kind === 'e' ? 'enum' : 'domain',
      enum_values:Array.isArray(type.enum_values) ? type.enum_values : [],
      domain_base:type.type_kind === 'd' ? type.domain_base : null,
    }));
  }

  const constraints = await rows(client, `
    SELECT n.nspname AS table_schema,
           c.relname AS table_name,
           con.conname AS constraint_name,
           con.contype AS constraint_type,
           pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND c.relkind IN ('r', 'p')
    ORDER BY n.nspname, c.relname, con.conname
  `);
  for (const constraint of constraints) {
    const anchor = `constraint:${constraint.constraint_name}`;
    candidates.push(candidate(`${constraint.table_schema}.${constraint.table_name}`, anchor, {
      kind:'constraint',
      constraint_type:constraint.constraint_type,
      definition:constraint.definition,
    }));
  }

  candidates.sort((a, b) => a.source_identity.localeCompare(b.source_identity));
  return candidates;
}

function postgresClient() {
  return new Client({
    host:process.env.PGHOST || '127.0.0.1',
    port:Number(process.env.PGPORT || 5432),
    database:process.env.PGDATABASE || 'overcenter',
    user:process.env.PGUSER || 'overcenter',
    password:process.env.PGPASSWORD || 'overcenter',
  });
}

export function createPostgresDiscoverer(options = {}) {
  const migrationsRoot = options.migrationsRoot || 'migrations';
  return {
    name:'overcenter-postgres',
    async discover({ repoRoot }) {
      const client = options.client || postgresClient();
      const ownsClient = !options.client;
      if (ownsClient) await client.connect();
      try {
        await applyMigrations(client, join(repoRoot, migrationsRoot));
        const candidates = await introspectPostgresContracts(client);
        return { complete:true, candidates, diagnostics:[{ code:'POSTGRES_DISCOVERY_COMPLETE', count:candidates.length }] };
      } finally {
        if (ownsClient) await client.end();
      }
    },
  };
}
