import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';
import { projectAuthoringFor } from 'lib/project-authoring-overcenter-host.js';
import { PROJECT_DEFINE_INPUT_SCHEMA } from 'lib/project-authoring-mcp-contract.js';

export const access = 'admin';
export default {
  name:'project.define',
  description:'Define canonical repository-owned project graph facts at an exact observed Git revision. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.',
  inputSchema:PROJECT_DEFINE_INPUT_SCHEMA,
  async handler(args,ctx) {
    const providers = composeHatchableRuntimeProviders({ ...(ctx?.db ? { db:ctx.db } : {}) });
    const { db } = providers;
    const response = await executeSemanticWorkerCommand('project.define', args || {}, {
      db,
      projectAuthoring:projectAuthoringFor({ db, withGitHubAppApiClient:providers.githubAppAuth.withApiClient }),
      logger:console,
    });
    return response.body;
  },
};