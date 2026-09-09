import { config } from 'hatchable';
import { createGcpCommandForwarder } from 'lib/gcp-command-forwarder.js';
import { createGitHubAppAuth } from 'lib/github-app-auth.js';

const hatchableSecrets = Object.freeze({
  get(name) {
    return config.get(name);
  },
});

export function createHatchableGcpCommandAdapter(overrides = {}) {
  const configProvider = overrides.config ?? config;
  const githubAppAuth = overrides.githubAppAuth ?? createGitHubAppAuth({ secrets:overrides.secrets ?? hatchableSecrets });
  const fetchImpl = overrides.fetchImpl ?? fetch;

  return Object.freeze({
    async execute(command, input = {}) {
      const ingressUrl = await configProvider.get('OVERCENTER_GCP_COMMAND_INGRESS_URL');
      const forwarder = createGcpCommandForwarder({
        ingressUrl,
        mintCallerToken:() => githubAppAuth.mintAppJwt(),
        fetchImpl,
      });
      return forwarder.execute(command, input);
    },
  });
}
