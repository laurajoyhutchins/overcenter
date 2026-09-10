import { config } from 'hatchable';
import { createGitHubAppAuth } from 'lib/github-app-auth.js';
import { dispatchGcpProjectAmendViaWorkflow } from 'lib/gcp-semantic-project-amend-relay.js';
import { PROJECT_AMEND_INPUT_SCHEMA } from 'lib/project-authoring-mcp-contract.js';

const secrets = Object.freeze({ get(name) { return config.get(name); } });

export const access = 'admin';
export default {
  name:'project.amend',
  description:'Amend canonical repository-owned project graph facts at an exact observed Git revision. Hatchable only transports the bounded semantic request; authoritative execution, mutation fencing, retry identity, durable GitHub mutation, and readback run on GCP.',
  inputSchema:PROJECT_AMEND_INPUT_SCHEMA,
  async handler(args) {
    const githubAppAuth = createGitHubAppAuth({ secrets });
    return dispatchGcpProjectAmendViaWorkflow(args || {}, {
      withGitHubAppApiClient:githubAppAuth.withApiClient,
    });
  },
};
