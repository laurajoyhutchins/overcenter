import { composeHatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { projectAdvanceFor } from 'lib/project-advance-overcenter-host.js';
import { createPostgresProjectTransitionAuthoritativeEffectConfirmationService } from 'lib/project-transition-authoritative-effect-github-runtime.js';
import { createPostgresSubjectAwareOrchestrationRunService } from 'lib/orchestration-finish-runtime.js';
import {
  createPostgresOrchestrationAdvanceService,
  createPostgresTargetAwareOrchestrationRunService,
  statusForOrchestrationAdvanceRuntimeError,
} from 'lib/orchestration-run-target-runtime.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('project.advance');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx) {
    const providers = composeHatchableRuntimeProviders({
      ...(ctx?.db ? { db:ctx.db } : {}),
      ...(ctx?.executionTransactionStore ? { executionTransactionStore:ctx.executionTransactionStore } : {}),
    });
    const { db } = providers;
    const runtime = {
      db,
      api:providers.api,
      withGitHubAppApiClient:providers.githubAppAuth.withApiClient,
      executionTransactionStore:providers.executionTransactionStore,
    };
    const runs = createPostgresTargetAwareOrchestrationRunService(runtime);
    const advance = createPostgresOrchestrationAdvanceService(runtime);
    const finish = createPostgresSubjectAwareOrchestrationRunService(runtime);
    const authoritativeEffect = createPostgresProjectTransitionAuthoritativeEffectConfirmationService(runtime);
    const response = await executeCorrelatedCommand(
      'project.advance',
      args || {},
      (input) => projectAdvanceFor({
        db,
        runs,
        advance,
        finish,
        confirmAuthoritativeEffect:(request) => authoritativeEffect.confirm(request),
      }).advance(input),
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