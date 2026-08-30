import { db as hatchableDb } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createAuthoritativeProjectGraphReader } from 'lib/project-graph-authority.js';
import { createGitHubProjectGraphRuntime } from 'lib/project-graph-github-runtime.js';
import { projectInspectFor } from 'lib/project-inspect-overcenter-host.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('project.inspect');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const db = ctx?.db || hatchableDb;
    const graphRuntime = createGitHubProjectGraphRuntime({ db });
    const readProjectGraph = createAuthoritativeProjectGraphReader(graphRuntime);
    const response = await executeCorrelatedCommand(
      'project.inspect',
      args || {},
      (input) => projectInspectFor({ readProjectGraph }).inspect(input),
      {
        statusForFailure:() => null,
        defaultError:'PROJECT_INSPECT_ERROR',
        defaultMessage:'project.inspect failed',
        flattenDetails:true,
        db,
      },
    );
    return response.body;
  },
};