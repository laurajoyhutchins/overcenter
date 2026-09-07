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

export function composeCloudRunRuntimeProviders({ db, env = process.env } = {}) {
  const secrets = requiredEnvSecretProvider(env);
  const githubAppAuth = createGitHubAppAuth({ secrets });
  return createRuntimeProviders({
    db,
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
  const providers = composeCloudRunRuntimeProviders({ db, env });
  const inspector = projectInspectForGitHub({
    db,
    withGitHubAppApiClient:providers.githubAppAuth.withApiClient,
    createGitHubProjectGraphRuntime,
  });
  return (input = {}) => inspector.inspect(input);
}

export function createCloudRunSemanticWorker({ db, env = process.env, logger = console } = {}) {
  const providers = composeCloudRunRuntimeProviders({ db, env });
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