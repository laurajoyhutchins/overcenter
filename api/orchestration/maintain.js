import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresSubjectAwareOrchestrationMaintenanceService } from 'lib/orchestration-maintenance-subjects.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
export const access='admin'; export const methods=['POST'];
export default async function(req,res){ const response=await executeCorrelatedCommand('orchestration.maintain',req.body||{},()=>createPostgresSubjectAwareOrchestrationMaintenanceService().maintain(),{statusForFailure:statusForOrchestrationRunError,defaultError:'ORCHESTRATION_MAINTENANCE_ERROR',defaultMessage:'orchestration.maintain failed',flattenDetails:true}); return res.status(response.status).json(response.body); }