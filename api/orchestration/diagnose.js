import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresSubjectAwareOrchestrationDiagnosisService } from 'lib/orchestration-diagnose-runtime.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';

export const access = 'admin';
export const methods = ['POST'];

export default async function(req, res) {
  const response = await executeCorrelatedCommand(
    'orchestration.diagnose',
    req.body || {},
    (input) => createPostgresSubjectAwareOrchestrationDiagnosisService().diagnose(input),
    {
      statusForFailure: statusForOrchestrationRunError,
      defaultError: 'ORCHESTRATION_DIAGNOSE_ERROR',
      defaultMessage: 'orchestration.diagnose failed',
      flattenDetails: true,
    },
  );
  return res.status(response.status).json(response.body);
}