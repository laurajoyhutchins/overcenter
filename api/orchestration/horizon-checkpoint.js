import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresOrchestrationRunService, statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { canonicalHorizonCommand } from 'lib/operator-commands.js';
export const access='admin'; export const methods=['POST'];
export default async function(req,res){ const input=canonicalHorizonCommand(req.body||{}); const response=await executeCorrelatedCommand('orchestration.horizon_checkpoint',input,request=>createPostgresOrchestrationRunService().checkpointHorizon(request),{statusForFailure:statusForOrchestrationRunError,defaultError:'ORCHESTRATION_HORIZON_ERROR',defaultMessage:'orchestration.horizon_checkpoint failed',flattenDetails:true}); return res.status(response.status).json(response.body); }