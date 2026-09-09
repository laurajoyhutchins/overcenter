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

function withMutationCertainty(error, mayHaveMutated) {
  if (typeof error?.may_have_mutated === 'boolean' || typeof error?.details?.may_have_mutated === 'boolean') return error;
  if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      error.may_have_mutated = mayHaveMutated;
      return error;
    } catch {}
  }
  const wrapped = new Error(error instanceof Error ? error.message : String(error));
  if (error?.code != null) wrapped.code = error.code;
  wrapped.cause = error;
  wrapped.may_have_mutated = mayHaveMutated;
  return wrapped;
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
      let client;
      try {
        client = await db.connect();
      } catch (error) {
        throw withMutationCertainty(error, false);
      }

      let began = false;
      let commitAttempted = false;
      try {
        await client.query('BEGIN');
        began = true;
        const results = [];
        for (const statement of normalized) {
          results.push(normalizeDatabaseResult(await client.query(statement.sql, statement.params)));
        }
        commitAttempted = true;
        await client.query('COMMIT');
        return Object.freeze({ results:Object.freeze(results) });
      } catch (error) {
        if (!began) throw withMutationCertainty(error, false);

        let rollbackSucceeded = false;
        try {
          await client.query('ROLLBACK');
          rollbackSucceeded = true;
        } catch {}

        if (commitAttempted) throw withMutationCertainty(error, true);
        throw withMutationCertainty(error, !rollbackSucceeded);
      } finally {
        client.release();
      }
    },
  });
}
