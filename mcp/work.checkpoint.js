import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalCheckpointCommand } from 'lib/operator-commands.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export const access = 'admin';
const evidence = { type:'array', maxItems:50, items:{ type:'object', required:['kind','ref'], properties:{kind:{type:'string'},ref:{type:'string'}}, additionalProperties:false } };
const revisions = { type:'array', maxItems:25, items:{ type:'object', required:['kind','ref','revision'], properties:{kind:{type:'string'},ref:{type:'string'},revision:{type:'string'}}, additionalProperties:false } };

export default {
  name: 'work.checkpoint',
  description: 'Persist useful bounded progress under an active lease. Supply semantic progress only; schema, run correlation, canonical serialization, request hash, and retry identity are derived deterministically.',
  inputSchema: {
    type:'object', required:['lease_token','phase','next_action'],
    properties:{
      lease_token:{type:'string'}, phase:{type:'string'}, next_action:{type:'string', minLength:1, maxLength:128},
      candidate:{type:['object','null']}, completed:evidence, evidence, authority_revisions:revisions,
    }, additionalProperties:false,
  },
  async handler(args,ctx){
    const failureOptions={statusForFailure:statusForWorkLeaseError,defaultError:'WORK_CHECKPOINT_ERROR',defaultMessage:'work.checkpoint failed',flattenDetails:true,db:ctx?.db};
    let input;
    try { input=await canonicalCheckpointCommand(args||{},ctx?.db); }
    catch(error){ return workerBoundaryCommandFailure('work.checkpoint',error,failureOptions).body; }
    const response=await executeCorrelatedCommand('work.checkpoint',input,request=>createPostgresWorkLeaseService({db:ctx?.db}).checkpoint(request),workerBoundaryFailureOptions('work.checkpoint',failureOptions));
    return response.body;
  },
};