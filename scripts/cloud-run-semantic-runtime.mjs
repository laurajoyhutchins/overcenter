import { commandFailure } from '../lib/command-response.js';
import { createGitHubAppAuth } from '../lib/github-app-auth.js';
import { projectAuthoringFor } from '../lib/project-authoring-overcenter-host.js';
import { createGitHubProjectGraphRuntime } from '../lib/project-graph-github-runtime.js';
import { projectInspectForGitHub } from '../lib/project-inspect-github-runtime.js';
import { createRuntimeProviders } from '../lib/runtime-providers.js';
import { createWorkerCommandHandler } from '../lib/worker-command-handler.js';
import { executeSemanticWorkerCommand } from '../lib/worker-transport.js';

function requiredEnvSecretProvider(env) {
  return Object.freeze({
    async get(name) {
      const value = typeof env?.[name] === 'string' ? env[name].trim() : '';
      if (!value) {
        throw Object.assign(new Error(`runtime secret ${name} is required`), {
          code:'RUNTIME_PROVIDER_MISSING',
          details:{ provider:'secrets', secret:name },
          mayHaveMutated:false,
        });
      }
      return value;
    },
  });
}

function unavailableProvider(provider, method) {
  return async function unavailable() {
    throw Object.assign(new Error(`runtime provider ${provider}.${method} is unavailable on the GCP host`), {
      code:'RUNTIME_PROVIDER_UNAVAILABLE',
      details:{ provider, method },
      mayHaveMutated:false,
    });
  };
}

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
    query:(sql, params) => db.query(sql, params),
    async transaction(statements) {
      const normalized = normalizedTransactionStatements(statements);
      const client = await db.connect();
      let began = false;
      try {
        await client.query('BEGIN');
        began = true;
        const results = [];
        for (const statement of normalized) {
          results.push(await client.query(statement.sql, statement.params));
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

export function composeCloudRunRuntimeProviders({ db, env = process.env } = {}) {
  const database = createCloudRunDatabaseBinding(db);
  const secrets = requiredEnvSecretProvider(env);
  const githubAppAuth = createGitHubAppAuth({ secrets });
  return createRuntimeProviders({
    db:database,
    secrets,
    githubAppAuth,
    storage:Object.freeze({
      get:unavailableProvider('storage', 'get'),
      put:unavailableProvider('storage', 'put'),
    }),
    api:Object.freeze({ call:unavailableProvider('api', 'call') }),
  });
}

export function createCloudRunReadOnlyProjectInspector({ db, env = process.env } = {}) {
  const database = createCloudRunDatabaseBinding(db);
  const providers = composeCloudRunRuntimeProviders({ db:database, env });
  const inspector = projectInspectForGitHub({
    db:database,
    withGitHubAppApiClient:providers.githubAppAuth.withApiClient,
    createGitHubProjectGraphRuntime,
  });
  return (input = {}) => inspector.inspect(input);
}

export function createCloudRunSemanticWorker({ db, env = process.env, logger = console } = {}) {
  const database = createCloudRunDatabaseBinding(db);
  const providers = composeCloudRunRuntimeProviders({ db:database, env });
  const handler = createWorkerCommandHandler({
    providers,
    commandFailure,
    projectAuthoringFor,
    executeSemanticWorkerCommand,
    logger,
  });

  return async function executeWorkerCommand(body = {}) {
    let statusCode = 200;
    let responseBody = null;
    const response = {
      status(code) {
        statusCode = Number(code) || 500;
        return this;
      },
      json(value) {
        responseBody = value;
        return value;
      },
    };
    await handler({ body }, response);
    return Object.freeze({ status:statusCode, body:responseBody });
  };
}
