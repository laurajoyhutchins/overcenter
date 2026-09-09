function normalizedTransactionStatements(statements) {
  if (!Array.isArray(statements) || statements.length === 0) {
    throw Object.assign(new Error('database transaction requires at least one statement'), {
      code:'RUNTIME_DATABASE_TRANSACTION_INVALID',
      may_have_mutated:false,
    });
  }
  return statements.map((statement, index) => {
    const sql = typeof statement?.sql === 'string' ? statement.sql.trim() : '';
    if (!sql) {
      throw Object.assign(new Error(`database transaction statement ${index} requires sql`), {
        code:'RUNTIME_DATABASE_TRANSACTION_INVALID',
        may_have_mutated:false,
      });
    }
    return Object.freeze({ sql:statement.sql, params:Array.isArray(statement?.params) ? statement.params : [] });
  });
}

function normalizeDatabaseRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  let changed = false;
  const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value instanceof Date) {
      changed = true;
      return [key, value.toISOString()];
    }
    return [key, value];
  }));
  return changed ? normalized : row;
}

function normalizeDatabaseResult(result) {
  if (!result || !Array.isArray(result.rows)) return result;
  const rows = result.rows.map(normalizeDatabaseRow);
  return Object.freeze({ ...result, rows:Object.freeze(rows) });
}

export function createCloudRunDatabaseBinding(db) {
  if (!db || typeof db.query !== 'function') {
    throw Object.assign(new Error('Cloud Run database provider requires query support'), {
      code:'RUNTIME_DATABASE_QUERY_UNAVAILABLE',
      may_have_mutated:false,
    });
  }
  if (typeof db.transaction === 'function') return db;
  if (typeof db.connect !== 'function') {
    throw Object.assign(new Error('Cloud Run database provider requires transaction support'), {
      code:'RUNTIME_DATABASE_TRANSACTION_UNAVAILABLE',
      may_have_mutated:false,
    });
  }

  return Object.freeze({
    async query(sql, params) {
      return normalizeDatabaseResult(await db.query(sql, params));
    },
    async transaction(statements) {
      const normalized = normalizedTransactionStatements(statements);
      const client = await db.connect();
      let began = false;
      try {
        await client.query('BEGIN');
        began = true;
        const results = [];
        for (const statement of normalized) {
          results.push(normalizeDatabaseResult(await client.query(statement.sql, statement.params)));
        }
        await client.query('COMMIT');
        return Object.freeze({ results:Object.freeze(results) });
      } catch (error) {
        if (began) {
          try { await client.query('ROLLBACK'); } catch {}
        }
        throw error;
      } finally {
        client.release();
      }
    },
  });
}
