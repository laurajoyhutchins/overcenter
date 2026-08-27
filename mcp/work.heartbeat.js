import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalHeartbeatCommandByRef } from 'lib/operator-commands.js';
import { WORK_HEARTBEAT_INPUT_SCHEMA } from 'lib/work-progress-contract.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export const access='admin';

export default {
  name:'work.heartbeat',
  description:'Extend a materially progressing active lease by non-secret lease reference. Run correlation, capability material, and retry identity remain internal. Supply fresh progress inline when it has advanced, or omit progress fields to use the latest durable checkpoint.',
  inputSchema:WORK_HEARTBEAT_INPUT_SCHEMA,
  async handler(args,ctx){const failureOptions={statusForFailure:statusForWorkLeaseError,defaultError:'WORK_HEARTBEAT_ERROR',defaultMessage:'work.heartbeat failed',flattenDetails:true,db:ctx?.db};let input;try{input=await canonicalHeartbeatCommandByRef(args||{},ctx?.db);}catch(error){return workerBoundaryCommandFailure('work.heartbeat',error,failureOptions).body;}const response=await executeCorrelatedCommand('work.heartbeat',input,request=>createPostgresWorkLeaseService({db:ctx?.db}).heartbeatByRef(request),workerBoundaryFailureOptions('work.heartbeat',failureOptions));return response.body;}
};