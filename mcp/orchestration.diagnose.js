import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresOrchestrationDiagnosisService } from 'lib/orchestration-recovery.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';

export const access = 'admin';

export default {
  name: 'orchestration.diagnose',
  description: 'Read current durable orchestration state and return the typed failure class, exact deterministic recovery operation, and escalation boundary. This is state inspection and recovery classification only; it does not plan or select work.',
  inputSchema: {
    type: 'object',
    required: ['run_id'],
    properties: {
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
      work_ref: { type: 'string', minLength: 1, maxLength: 128 },
    },
    additionalProperties: false,
  },
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