import { db as hatchableDb } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { projectAdvanceFor } from 'lib/project-advance-overcenter-host.js';
import { statusForOrchestrationAdvanceRuntimeError } from 'lib/orchestration-run-target-runtime.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('project.advance');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const db = ctx?.db || hatchableDb;
    const response = await executeCorrelatedCommand(
      'project.advance',
      args || {},
      (input) => projectAdvanceFor({ db }).advance(input),
      {
        statusForFailure:statusForOrchestrationAdvanceRuntimeError,
        defaultError:'PROJECT_ADVANCE_ERROR',
        defaultMessage:'project.advance failed',
        flattenDetails:true,
        db,
      },
    );
    return response.body;
  },
};