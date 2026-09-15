import { invokeAuthoritativeSemanticCommand } from 'lib/authoritative-semantic-command-ingress.js';
import { composeMcpRuntimeProviders } from 'lib/mcp-runtime-composition.js';
import { normalizeProjectAmendInput } from 'lib/project-amend-command-input.js';
import { PROJECT_AMEND_INPUT_SCHEMA } from 'lib/project-authoring-mcp-contract.js';

export const access = 'admin';
export default {
  name:'project.amend',
  description:'Amend canonical repository-owned project graph facts at an exact observed Git revision using semantic transition intent. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.',
  inputSchema:PROJECT_AMEND_INPUT_SCHEMA,
  async handler(args,ctx) {
    const request = normalizeProjectAmendInput(args || {});
    const providers = composeMcpRuntimeProviders(ctx);
    const invocation = await invokeAuthoritativeSemanticCommand({
      command:'project.amend',
      project_ref:request.project_ref,
      input:request,
    }, {
      withGitHubAppApiClient:providers.githubAppAuth.withApiClient,
    });
    return Object.freeze({
      ...invocation,
      expected_revision:request.expected_revision,
    });
  },
};
