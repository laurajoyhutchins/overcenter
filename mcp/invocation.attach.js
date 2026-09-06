import { db as hatchableDb } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresInvocationObservationService } from 'lib/invocation-observation.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('invocation.attach');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args, ctx) {
    const db = ctx?.db || hatchableDb;
    const service = createPostgresInvocationObservationService({ db });
    const response = await executeCorrelatedCommand(
      'invocation.attach',
      args || {},
      (input) => service.attach(input),
      { defaultError:'INVOCATION_ATTACH_ERROR', defaultMessage:'invocation.attach failed', flattenDetails:true, db },
    );
    return response.body;
  },
};