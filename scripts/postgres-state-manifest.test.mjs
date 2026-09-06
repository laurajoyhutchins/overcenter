import assert from 'node:assert/strict';
import test from 'node:test';

import {
  comparePostgresStateManifests,
  createPostgresStateManifest,
} from './postgres-state-manifest.mjs';

const SHADOW_ONLY_TABLES = ['overcenter_runtime_deployments'];

function fakeDb() {
  return {
    async query(text, params = []) {
      if (text.includes('FROM information_schema.tables')) {
        return { rows: [
          { table_schema: 'public', table_name: 'execution_state' },
          { table_schema: 'public', table_name: 'overcenter_runtime_deployments' },
          { table_schema: 'public', table_name: 'work_leases' },
        ] };
      }
      if (text.includes('FROM information_schema.columns')) {
        const table = params[1];
        const columns = table === 'execution_state'
          ? [
              { column_name: 'scope', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, ordinal_position: 1 },
              { column_name: 'payload', data_type: 'jsonb', udt_name: 'jsonb', is_nullable: 'NO', column_default: null, ordinal_position: 2 },
            ]
          : [
              { column_name: 'lease_id', data_type: 'text', udt_name: 'text', is_nullable: 'NO', column_default: null, ordinal_position: 1 },
            ];
        return { rows: columns };
      }
      if (text.includes('FROM "public"."execution_state"')) {
        return { rows: [
          { row_json: '{"scope":"b","payload":{"n":2}}' },
          { row_json: '{"scope":"a","payload":{"n":1}}' },
        ] };
      }
      if (text.includes('FROM "public"."work_leases"')) {
        return { rows: [{ row_json: '{"lease_id":"lease-1"}' }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

test('state manifest hashes schema and sorted row content while excluding host-local tables', async () => {
  const manifest = await createPostgresStateManifest(fakeDb(), {
    excludeTables: SHADOW_ONLY_TABLES,
  });

  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.excludedTables, SHADOW_ONLY_TABLES);
  assert.deepEqual(manifest.tables.map(table => [table.name, table.rowCount]), [
    ['execution_state', 2],
    ['work_leases', 1],
  ]);
  for (const table of manifest.tables) {
    assert.match(table.schemaSha256, /^[0-9a-f]{64}$/);
    assert.match(table.rowsSha256, /^[0-9a-f]{64}$/);
  }
});

test('state manifest is deterministic across database row order', async () => {
  const first = await createPostgresStateManifest(fakeDb(), {
    excludeTables: SHADOW_ONLY_TABLES,
  });
  const reversed = fakeDb();
  const originalQuery = reversed.query.bind(reversed);
  reversed.query = async (text, params) => {
    const result = await originalQuery(text, params);
    if (text.includes('row_to_json')) return { rows: [...result.rows].reverse() };
    return result;
  };

  const second = await createPostgresStateManifest(reversed, {
    excludeTables: SHADOW_ONLY_TABLES,
  });
  assert.deepEqual(second, first);
});

test('manifest comparison pinpoints schema, row-count, and row-hash drift', () => {
  const source = {
    version: 1,
    excludedTables: [],
    tables: [
      { name: 'execution_state', schemaSha256: 'a', rowCount: 2, rowsSha256: 'b' },
      { name: 'work_leases', schemaSha256: 'c', rowCount: 1, rowsSha256: 'd' },
    ],
  };
  const target = {
    version: 1,
    excludedTables: [],
    tables: [
      { name: 'execution_state', schemaSha256: 'a', rowCount: 3, rowsSha256: 'z' },
      { name: 'work_leases', schemaSha256: 'x', rowCount: 1, rowsSha256: 'd' },
    ],
  };

  const comparison = comparePostgresStateManifests(source, target);
  assert.equal(comparison.ok, false);
  assert.deepEqual(comparison.differences, [
    { table: 'execution_state', field: 'rowCount', source: 2, target: 3 },
    { table: 'execution_state', field: 'rowsSha256', source: 'b', target: 'z' },
    { table: 'work_leases', field: 'schemaSha256', source: 'c', target: 'x' },
  ]);
});
