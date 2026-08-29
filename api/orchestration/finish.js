import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresSubjectAwareOrchestrationRunService } from 'lib/orchestration-finish-runtime.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { canonicalFinishCommand } from 'lib/operator-commands.js';
export const access='admin'; export const methods=['POST'];
export default async function(req,res){ const input=canonicalFinishCommand(req.body||{}); const response=await executeCorrelatedCommand('orchestration.finish',input,request=>createPostgresSubjectAwareOrchestrationRunService().finish(request),{statusForFailure:statusForOrchestrationRunError,defaultError:'ORCHESTRATION_FINISH_ERROR',defaultMessage:'orchestration.finish failed',flattenDetails:true}); return res.status(response.status).json(response.body); }