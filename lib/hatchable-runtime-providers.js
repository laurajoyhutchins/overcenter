import { api, config, db, storage } from 'hatchable';
import { createGitHubAppAuth } from 'lib/github-app-auth.js';
import { createRuntimeProviders } from 'lib/runtime-providers.js';

const hatchableSecrets = Object.freeze({
  get(name) {
    return config.get(name);
  },
});

export function composeHatchableRuntimeProviders(overrides = {}) {
  const secrets = overrides.secrets ?? hatchableSecrets;
  const githubAppAuth = overrides.githubAppAuth ?? createGitHubAppAuth({ secrets });
  return createRuntimeProviders({
    db:overrides.db ?? db,
    secrets,
    githubAppAuth,
    storage:overrides.storage ?? storage,
    api:overrides.api ?? api,
  });
}

export const hatchableRuntimeProviders = composeHatchableRuntimeProviders();