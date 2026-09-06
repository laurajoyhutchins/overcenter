import { db as hatchableDb } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresInvocationObservationService } from 'lib/invocation-observation.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('invocation.peek');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args, ctx) {
    const db = ctx?.db || hatchableDb;
    const service = createPostgresInvocationObservationService({ db });
    const response = await executeCorrelatedCommand(
      'invocation.peek',
      args || {},
      (input) => service.peek(input),
      { defaultError:'INVOCATION_PEEK_ERROR', defaultMessage:'invocation.peek failed', flattenDetails:true, db },
    );
    return response.body;
  },
};