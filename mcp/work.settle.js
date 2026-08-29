import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalSettleCommandByRef } from 'lib/operator-commands.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

const descriptor = semanticCommandDescriptor('work.settle');

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx){const failureOptions={statusForFailure:statusForWorkLeaseError,defaultError:'WORK_SETTLE_ERROR',defaultMessage:'work.settle failed',flattenDetails:true,db:ctx?.db};let input;try{input=await canonicalSettleCommandByRef(args||{},ctx?.db);}catch(error){return workerBoundaryCommandFailure('work.settle',error,failureOptions).body;}const response=await executeCorrelatedCommand('work.settle',input,request=>createPostgresWorkLeaseService({db:ctx?.db}).settleByRef(request),workerBoundaryFailureOptions('work.settle',failureOptions));return response.body;}
};
