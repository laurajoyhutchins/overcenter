import { db as hatchableDb } from 'hatchable';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';
import { projectAuthoringFor } from 'lib/project-authoring-overcenter-host.js';
import { PROJECT_AMEND_INPUT_SCHEMA } from 'lib/project-authoring-mcp-contract.js';

export const access = 'admin';
export default {
  name:'project.amend',
  description:'Amend canonical repository-owned project graph facts at an exact observed Git revision using semantic transition intent. Overcenter owns repository layout, mutation fencing, retry identity, durable GitHub mutation, and authoritative graph readback.',
  inputSchema:PROJECT_AMEND_INPUT_SCHEMA,
  async handler(args,ctx) {
    const response = await executeSemanticWorkerCommand('project.amend', args || {}, {
      db:ctx?.db || hatchableDb,
      projectAuthoring:projectAuthoringFor({ db:ctx?.db || hatchableDb }),
      logger:console,
    });
    return response.body;
  },
};