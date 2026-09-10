import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { dispatchGcpProjectAmendViaWorkflow } from 'lib/gcp-semantic-project-amend-relay.js';
import { PROJECT_ADD_OBLIGATION_INPUT_SCHEMA } from 'lib/project-authoring-mcp-contract.js';
import { normalizeProjectAddObligationRequest } from 'lib/project-obligation-command-contract.js';

export const access = 'admin';
export default {
  name:'project.add_obligation',
  description:'Turn one bounded conversation-derived project judgment into an authoritative project obligation. Supply semantic obligation intent only; Overcenter lowers it to project.amend and owns repository layout, mutation fencing, durable mutation, and authoritative readback.',
  inputSchema:PROJECT_ADD_OBLIGATION_INPUT_SCHEMA,
  async handler(args, ctx) {
    const amendmentRequest = normalizeProjectAddObligationRequest(args || {});
    const providers = composeHatchableRuntimeProviders({ ...(ctx?.db ? { db:ctx.db } : {}) });
    return dispatchGcpProjectAmendViaWorkflow(amendmentRequest, {
      withGitHubAppApiClient:providers.githubAppAuth.withApiClient,
    });
  },
};