import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresOrchestrationRunService,statusForOrchestrationRunError } from 'lib/orchestration-runs.js';
import { canonicalHorizonCommand } from 'lib/operator-commands.js';
export const access='admin';
export default {
  name:'orchestration.horizon_checkpoint',
  description:'Persist an agent-selected advisory horizon. Supply only bounded candidate identities plus fresh observed state/lane; Hatchable derives position, execution fingerprint, authority revision evidence, and digest. Horizons never grant ownership or choose work.',
  inputSchema:{type:'object',required:['run_id','candidates'],properties:{run_id:{type:'string'},candidates:{type:'array',minItems:1,maxItems:10,items:{type:'object',required:['work_ref','observed_state','observed_lane'],properties:{work_ref:{type:'string'},observed_state:{type:'string'},observed_lane:{type:'string'},selection_reason:{type:'string'},repository:{type:['string','null']}},additionalProperties:false}}},additionalProperties:false},
  async handler(args,ctx){const input=canonicalHorizonCommand(args||{});const r=await executeCorrelatedCommand('orchestration.horizon_checkpoint',input,request=>createPostgresOrchestrationRunService({db:ctx?.db}).checkpointHorizon(request),{statusForFailure:statusForOrchestrationRunError,defaultError:'ORCHESTRATION_HORIZON_ERROR',defaultMessage:'orchestration.horizon_checkpoint failed',flattenDetails:true,db:ctx?.db});return r.body;}
};