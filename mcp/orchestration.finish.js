import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresOrchestrationRunService,statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { canonicalFinishCommand } from 'lib/operator-commands.js';
export const access='admin';
export default {
  name:'orchestration.finish',description:'Persist a machine-readable run handoff after all owned leases are settled. Accepts canonical hyphenated dispositions and common underscore aliases; it does not change work authority.',
  inputSchema:{type:'object',required:['run_id','disposition'],properties:{run_id:{type:'string'},disposition:{type:'string',enum:['completed','clean-stop','clean_stop','blocked','failed','no-work','no_work']},last_work_ref:{type:['string','null']},last_gate:{type:['string','null']},stop_reason:{type:['string','null']}},additionalProperties:false},
  async handler(args,ctx){const input=canonicalFinishCommand(args||{});const r=await executeCorrelatedCommand('orchestration.finish',input,request=>createPostgresOrchestrationRunService({db:ctx?.db}).finish(request),{statusForFailure:statusForOrchestrationRunError,defaultError:'ORCHESTRATION_FINISH_ERROR',defaultMessage:'orchestration.finish failed',flattenDetails:true,db:ctx?.db});return r.body;}
};