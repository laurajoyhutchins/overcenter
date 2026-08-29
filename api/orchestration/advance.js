import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresOrchestrationAdvanceService, statusForOrchestrationAdvanceRuntimeError } from 'lib/orchestration-run-target-runtime.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function(req,res) {
  const response = await executeCorrelatedCommand(
    'orchestration.advance',
    req.body || {},
    (input) => createPostgresOrchestrationAdvanceService().advance(input),
    {
      statusForFailure:statusForOrchestrationAdvanceRuntimeError,
      defaultError:'ORCHESTRATION_ADVANCE_ERROR',
      defaultMessage:'orchestration.advance failed',
      flattenDetails:true,
    },
  );
  return res.status(response.status).json(response.body);
}
