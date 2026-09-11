import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { invocationObservationFor } from 'lib/invocation-observation.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('invocation.attach');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const providers = composeHatchableRuntimeProviders({ ...(ctx?.db ? { db:ctx.db } : {}) });
    const { db } = providers;
    const response = await executeCorrelatedCommand(
      'invocation.attach',
      args || {},
      (input) => invocationObservationFor(db).attach(input),
      {
        statusForFailure:() => null,
        defaultError:'INVOCATION_ATTACH_ERROR',
        defaultMessage:'invocation.attach failed',
        flattenDetails:true,
        db,
      },
    );
    return response.body;
  },
};
