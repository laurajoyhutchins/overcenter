import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { productionReconciliationFor } from 'lib/production-reconcile-overcenter-host.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('production.reconcile');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const providers = composeHatchableRuntimeProviders({ ...(ctx?.db ? { db:ctx.db } : {}) });
    const { db } = providers;
    const response = await executeCorrelatedCommand(
      'production.reconcile',
      args || {},
      (input) => productionReconciliationFor({ db, withGitHubAppApiClient:providers.githubAppAuth.withApiClient }).reconcile(input),
      {
        statusForFailure:() => null,
        defaultError:'PRODUCTION_RECONCILIATION_ERROR',
        defaultMessage:'production.reconcile failed',
        flattenDetails:true,
        db,
      },
    );
    return response.body;
  },
};