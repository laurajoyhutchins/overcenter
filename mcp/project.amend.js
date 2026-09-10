import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { dispatchGcpProjectAmendViaWorkflow } from 'lib/gcp-semantic-project-amend-relay.js';
import { PROJECT_AMEND_INPUT_SCHEMA } from 'lib/project-authoring-mcp-contract.js';

export const access = 'admin';
export default {
  name:'project.amend',
  description:'Amend canonical repository-owned project graph facts at an exact observed Git revision using semantic transition intent. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.',
  inputSchema:PROJECT_AMEND_INPUT_SCHEMA,
  async handler(args,ctx) {
    const providers = composeHatchableRuntimeProviders({ ...(ctx?.db ? { db:ctx.db } : {}) });
    return dispatchGcpProjectAmendViaWorkflow(args || {}, {
      withGitHubAppApiClient:providers.githubAppAuth.withApiClient,
    });
  },
};
