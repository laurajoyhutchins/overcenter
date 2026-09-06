import { db as hatchableDb } from 'hatchable';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';
import { executeSemanticWorkerCommand } from 'lib/worker-transport.js';
export const access='admin';
const descriptor=semanticCommandDescriptor('project.artifact.bind');
export default {name:descriptor.mcp_name,description:descriptor.description,inputSchema:descriptor.input_schema,async handler(args,ctx){const response=await executeSemanticWorkerCommand('project.artifact.bind',args||{},{db:ctx?.db||hatchableDb});return response.body;}};