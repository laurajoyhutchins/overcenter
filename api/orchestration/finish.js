import { hatchableRuntimeProviders } from 'lib/hatchable-runtime-providers.js';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresSubjectAwareOrchestrationRunService } from 'lib/orchestration-finish-runtime.js';
import { statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { canonicalFinishCommand } from 'lib/operator-commands.js';
export const access='admin'; export const methods=['POST'];
export default async function(req,res){ const runtime={db:hatchableRuntimeProviders.db,api:hatchableRuntimeProviders.api,withGitHubAppApiClient:hatchableRuntimeProviders.githubAppAuth.withApiClient}; const input=canonicalFinishCommand(req.body||{}); const response=await executeCorrelatedCommand('orchestration.finish',input,request=>createPostgresSubjectAwareOrchestrationRunService(runtime).finish(request),{statusForFailure:statusForOrchestrationRunError,defaultError:'ORCHESTRATION_FINISH_ERROR',defaultMessage:'orchestration.finish failed',flattenDetails:true,db:runtime.db}); return res.status(response.status).json(response.body); }