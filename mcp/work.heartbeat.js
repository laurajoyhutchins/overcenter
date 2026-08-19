import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalHeartbeatCommand } from 'lib/operator-commands.js';

export const access='admin';
const evidence={type:'array',maxItems:50,items:{type:'object',required:['kind','ref'],properties:{kind:{type:'string'},ref:{type:'string'}},additionalProperties:false}};
const revisions={type:'array',maxItems:25,items:{type:'object',required:['kind','ref','revision'],properties:{kind:{type:'string'},ref:{type:'string'},revision:{type:'string'}},additionalProperties:false}};
export default {
  name:'work.heartbeat',
  description:'Extend a materially progressing active lease. Run correlation and retry identity are derived from the lease. Supply fresh progress inline when it has advanced, or omit progress fields to use the latest durable checkpoint.',
  inputSchema:{type:'object',required:['lease_token'],properties:{lease_token:{type:'string'},extend_seconds:{type:'integer',minimum:60,maximum:3600},phase:{type:'string'},next_action:{type:'string',minLength:1,maxLength:128},candidate:{type:['object','null']},completed:evidence,evidence,authority_revisions:revisions},additionalProperties:false},
  async handler(args,ctx){const input=await canonicalHeartbeatCommand(args||{},ctx?.db);const response=await executeCorrelatedCommand('work.heartbeat',input,request=>createPostgresWorkLeaseService({db:ctx?.db}).heartbeat(request),{statusForFailure:statusForWorkLeaseError,defaultError:'WORK_HEARTBEAT_ERROR',defaultMessage:'work.heartbeat failed',flattenDetails:true,db:ctx?.db});return response.body;}
};