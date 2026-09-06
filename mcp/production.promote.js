import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { productionPromotionFor } from 'lib/production-promotion-overcenter-host.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('production.promote');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const { db } = composeHatchableRuntimeProviders({ ...(ctx?.db ? { db:ctx.db } : {}) });
    const response = await executeCorrelatedCommand(
      'production.promote',
      args || {},
      (input) => productionPromotionFor({ db }).promote(input),
      {
        statusForFailure:() => null,
        defaultError:'PRODUCTION_PROMOTION_ERROR',
        defaultMessage:'production.promote failed',
        flattenDetails:true,
        db,
      },
    );
    return response.body;
  },
};