import { config } from 'hatchable';
import { createGitHubAppAuth } from 'lib/github-app-auth.js';

const hatchableSecrets = Object.freeze({
  get(name) {
    return config.get(name);
  },
});

export function composeHatchableGcpIngressAdapter(overrides = {}) {
  const secrets = overrides.secrets ?? hatchableSecrets;
  const githubAppAuth = overrides.githubAppAuth ?? createGitHubAppAuth({ secrets });
  return Object.freeze({ secrets, githubAppAuth });
}
