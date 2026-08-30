import { db as hatchableDb } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createGitHubProjectGraphRuntime } from 'lib/project-graph-github-runtime.js';
import { projectInspectForGitHub } from 'lib/project-inspect-github-runtime.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('project.inspect');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const db = ctx?.db || hatchableDb;
    const response = await executeCorrelatedCommand(
      'project.inspect',
      args || {},
      (input) => projectInspectForGitHub({ db, createGitHubProjectGraphRuntime }).inspect(input),
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