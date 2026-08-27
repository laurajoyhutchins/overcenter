import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalSettleCommandByRef } from 'lib/operator-commands.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export const access = 'admin';
export default {
  name:'work.settle',
  description:'Truthfully consume one valid work lease as completed, requeue, or blocked. Supply the non-secret lease_ref plus settlement semantics; lease capability lookup, run correlation, and deterministic retry identity are derived internally.',
  inputSchema:{type:'object',required:['lease_ref','disposition'],properties:{lease_ref:{type:'string'},disposition:{type:'string',enum:['completed','requeue','blocked']},evidence:{type:'array',items:{type:'object',required:['kind','ref'],properties:{kind:{type:'string'},ref:{type:'string'}},additionalProperties:false}},reason:{type:['string','null']},promotion_condition:{type:['string','null']},requeue_class:{type:['string','null'],enum:['resume_progress','retry_runtime_failure','wait_for_observable_change','stale_candidate','insufficient_execution_window',null]},continuation:{type:['object','null']},next_state:{type:['string','null']},next_lane:{type:['string','null']}},additionalProperties:false},
  async handler(args,ctx){const failureOptions={statusForFailure:statusForWorkLeaseError,defaultError:'WORK_SETTLE_ERROR',defaultMessage:'work.settle failed',flattenDetails:true,db:ctx?.db};let input;try{input=await canonicalSettleCommandByRef(args||{},ctx?.db);}catch(error){return workerBoundaryCommandFailure('work.settle',error,failureOptions).body;}const response=await executeCorrelatedCommand('work.settle',input,request=>createPostgresWorkLeaseService({db:ctx?.db}).settleByRef(request),workerBoundaryFailureOptions('work.settle',failureOptions));return response.body;}
};
