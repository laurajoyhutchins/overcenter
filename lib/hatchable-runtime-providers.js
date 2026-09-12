import { api, config, db, storage } from 'hatchable';
import { createGitHubAppAuth } from 'lib/github-app-auth.js';
import { createRuntimeProviders } from 'lib/runtime-providers.js';
import { fenceSourceApiProvider, fenceSourceGitHubAppAuth } from 'lib/source-authority-fence.js';

const hatchableSecrets = Object.freeze({
  get(name) {
    return config.get(name);
  },
});

export function composeHatchableRuntimeProviders(overrides = {}) {
  const dbBinding = overrides.db ?? db;
  const secrets = overrides.secrets ?? hatchableSecrets;
  const rawGithubAppAuth = overrides.githubAppAuth ?? createGitHubAppAuth({ secrets });
  const rawApi = overrides.api ?? api;
  const githubAppAuth = fenceSourceGitHubAppAuth(rawGithubAppAuth, dbBinding);
  const apiProvider = fenceSourceApiProvider(rawApi, dbBinding);
  return createRuntimeProviders({
    db:dbBinding,
    secrets,
    githubAppAuth,
    storage:overrides.storage ?? storage,
    api:apiProvider,
    executionTransactionStore:overrides.executionTransactionStore ?? null,
  });
}

export const hatchableRuntimeProviders = composeHatchableRuntimeProviders();