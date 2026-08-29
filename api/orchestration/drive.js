import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresOrchestrationDriveService, statusForOrchestrationDriveRuntimeError } from 'lib/orchestration-run-target-runtime.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function(req,res) {
  const response = await executeCorrelatedCommand(
    'orchestration.drive',
    req.body || {},
    (input) => createPostgresOrchestrationDriveService().drive(input),
    {
      statusForFailure:statusForOrchestrationDriveRuntimeError,
      defaultError:'ORCHESTRATION_DRIVE_ERROR',
      defaultMessage:'orchestration.drive failed',
      flattenDetails:true,
    },
  );
  return res.status(response.status).json(response.body);
}
