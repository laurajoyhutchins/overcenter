import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalHeartbeatCommand } from 'lib/operator-commands.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export const access='admin';
const evidence={type:'array',maxItems:50,items:{type:'object',required:['kind','ref'],properties:{kind:{type:'string'},ref:{type:'string'}},additionalProperties:false}};
const revisions={type:'array',maxItems:25,items:{type:'object',required:['kind','ref','revision'],properties:{kind:{type:'string'},ref:{type:'string'},revision:{type:'string'}},additionalProperties:false}};
export default {
  name:'work.heartbeat',
  description:'Extend a materially progressing active lease. Run correlation and retry identity are derived from the lease. Supply fresh progress inline when it has advanced, or omit progress fields to use the latest durable checkpoint.',
  inputSchema:{type:'object',required:['lease_token'],properties:{lease_token:{type:'string'},extend_seconds:{type:'integer',minimum:60,maximum:3600},phase:{type:'string'},next_action:{type:'string',minLength:1,maxLength:128},candidate:{type:['object','null']},completed:evidence,evidence,authority_revisions:revisions},additionalProperties:false},
  async handler(args,ctx){const failureOptions={statusForFailure:statusForWorkLeaseError,defaultError:'WORK_HEARTBEAT_ERROR',defaultMessage:'work.heartbeat failed',flattenDetails:true,db:ctx?.db};let input;try{input=await canonicalHeartbeatCommand(args||{},ctx?.db);}catch(error){return workerBoundaryCommandFailure('work.heartbeat',error,failureOptions).body;}const response=await executeCorrelatedCommand('work.heartbeat',input,request=>createPostgresWorkLeaseService({db:ctx?.db}).heartbeat(request),workerBoundaryFailureOptions('work.heartbeat',failureOptions));return response.body;}
};