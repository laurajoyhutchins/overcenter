import { db as hatchableDb } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { projectArtifactBindingFor } from 'lib/project-artifact-binding-runtime.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';
const descriptor=semanticCommandDescriptor('project.artifact.bind');
export const access='admin';
export default {name:descriptor.mcp_name,description:descriptor.description,inputSchema:descriptor.input_schema,async handler(args,ctx){const db=ctx?.db||hatchableDb; const response=await executeCorrelatedCommand('project.artifact.bind',args||{},(input)=>projectArtifactBindingFor({db}).mutate(input),{statusForFailure:()=>null,defaultError:'PROJECT_ARTIFACT_BINDING_ERROR',defaultMessage:'project.artifact.bind failed',flattenDetails:true,db}); return response.body;}};
