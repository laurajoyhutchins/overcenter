import { invokeAuthoritativeSemanticCommand } from 'lib/authoritative-semantic-command-ingress.js';
import { composeMcpRuntimeProviders } from 'lib/mcp-runtime-composition.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('project.artifact.bind');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const request = Object.freeze({ ...(args || {}) });
    const providers = composeMcpRuntimeProviders(ctx);
    return invokeAuthoritativeSemanticCommand({
      command:'project.artifact.bind',
      project_ref:request.project_ref,
      input:request,
    }, {
      withGitHubAppApiClient:providers.githubAppAuth.withApiClient,
    });
  },
};
