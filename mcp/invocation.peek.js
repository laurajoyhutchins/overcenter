import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { invocationObservationFor } from 'lib/invocation-observation.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('invocation.peek');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const providers = composeHatchableRuntimeProviders({ ...(ctx?.db ? { db:ctx.db } : {}) });
    const { db } = providers;
    const response = await executeCorrelatedCommand(
      'invocation.peek',
      args || {},
      (input) => invocationObservationFor(db).peek(input),
      {
        statusForFailure:() => null,
        defaultError:'INVOCATION_PEEK_ERROR',
        defaultMessage:'invocation.peek failed',
        flattenDetails:true,
        db,
      },
    );
    return response.body;
  },
};
