import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalSettleCommand } from 'lib/operator-commands.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export const access = 'admin';
export default {
  name:'work.settle',
  description:'Truthfully consume one valid work lease as completed, requeue, or blocked. Lease correlation and deterministic retry identity are derived internally; the caller supplies only settlement semantics.',
  inputSchema:{type:'object',required:['lease_token','disposition'],properties:{lease_token:{type:'string'},disposition:{type:'string',enum:['completed','requeue','blocked']},evidence:{type:'array',items:{type:'object',required:['kind','ref'],properties:{kind:{type:'string'},ref:{type:'string'}},additionalProperties:false}},reason:{type:['string','null']},promotion_condition:{type:['string','null']},requeue_class:{type:['string','null'],enum:['resume_progress','retry_runtime_failure','wait_for_observable_change','stale_candidate','insufficient_execution_window',null]},continuation:{type:['object','null']},next_state:{type:['string','null']},next_lane:{type:['string','null']}},additionalProperties:false},
  async handler(args,ctx){const failureOptions={statusForFailure:statusForWorkLeaseError,defaultError:'WORK_SETTLE_ERROR',defaultMessage:'work.settle failed',flattenDetails:true,db:ctx?.db};let input;try{input=await canonicalSettleCommand(args||{},ctx?.db);}catch(error){return workerBoundaryCommandFailure('work.settle',error,failureOptions).body;}const response=await executeCorrelatedCommand('work.settle',input,request=>createPostgresWorkLeaseService({db:ctx?.db}).settle(request),workerBoundaryFailureOptions('work.settle',failureOptions));return response.body;}
};