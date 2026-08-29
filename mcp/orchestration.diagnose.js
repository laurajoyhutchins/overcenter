import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresOrchestrationDiagnosisService } from 'lib/orchestration-recovery.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('orchestration.diagnose');

export const access = 'admin';

export default {
  name: descriptor.mcp_name,
  description: descriptor.description,
  inputSchema: descriptor.input_schema,
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'orchestration.diagnose',
      args || {},
      (input) => createPostgresOrchestrationDiagnosisService({ db: ctx?.db }).diagnose(input),
      {
        statusForFailure: statusForOrchestrationRunError,
        defaultError: 'ORCHESTRATION_DIAGNOSE_ERROR',
        defaultMessage: 'orchestration.diagnose failed',
        flattenDetails: true,
        db: ctx?.db,
      },
    );
    return response.body;
  },
};