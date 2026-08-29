import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalSettleCommandByRef } from 'lib/operator-commands.js';
import { WORK_SETTLE_INPUT_SCHEMA } from 'lib/work-settle-contract.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export const access = 'admin';
export default {
  name:'work.settle',
  description:'Truthfully consume one valid work lease as completed, requeue, or blocked. Supply the non-secret lease_ref plus settlement semantics; lease capability lookup, run correlation, and deterministic retry identity are derived internally.',
  inputSchema:WORK_SETTLE_INPUT_SCHEMA,
  async handler(args,ctx){const failureOptions={statusForFailure:statusForWorkLeaseError,defaultError:'WORK_SETTLE_ERROR',defaultMessage:'work.settle failed',flattenDetails:true,db:ctx?.db};let input;try{input=await canonicalSettleCommandByRef(args||{},ctx?.db);}catch(error){return workerBoundaryCommandFailure('work.settle',error,failureOptions).body;}const response=await executeCorrelatedCommand('work.settle',input,request=>createPostgresWorkLeaseService({db:ctx?.db}).settleByRef(request),workerBoundaryFailureOptions('work.settle',failureOptions));return response.body;}
};
