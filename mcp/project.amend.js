import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { dispatchGcpProjectAmendViaWorkflow } from 'lib/gcp-semantic-project-amend-relay.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('project.amend');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const providers = composeHatchableRuntimeProviders({ ...(ctx?.db ? { db:ctx.db } : {}) });
    return dispatchGcpProjectAmendViaWorkflow(args || {}, {
      withGitHubAppApiClient:providers.githubAppAuth.withApiClient,
    });
  },
};
