import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresSubjectAwareLeaseCheckpointService } from 'lib/orchestration-finish-runtime.js';
import { statusForWorkLeaseError } from 'lib/work-leases.js';
import { canonicalCheckpointCommandByRef } from 'lib/operator-commands.js';
import { WORK_CHECKPOINT_INPUT_SCHEMA } from 'lib/work-progress-contract.js';
import { workerBoundaryCommandFailure, workerBoundaryFailureOptions } from 'lib/worker-boundary-errors.js';

export const access = 'admin';

export default {
  name: 'work.checkpoint',
  description: 'Persist useful bounded progress under an active lease reference. Supply semantic progress only; lease capability material, schema, run correlation, canonical serialization, request hash, and retry identity remain internal.',
  inputSchema: WORK_CHECKPOINT_INPUT_SCHEMA,
  async handler(args,ctx){
    const failureOptions={statusForFailure:statusForWorkLeaseError,defaultError:'WORK_CHECKPOINT_ERROR',defaultMessage:'work.checkpoint failed',flattenDetails:true,db:ctx?.db};
    let input;
    try { input=await canonicalCheckpointCommandByRef(args||{},ctx?.db); }
    catch(error){ return workerBoundaryCommandFailure('work.checkpoint',error,failureOptions).body; }
    const response=await executeCorrelatedCommand('work.checkpoint',input,request=>createPostgresSubjectAwareLeaseCheckpointService({db:ctx?.db}).checkpointByRef(request),workerBoundaryFailureOptions('work.checkpoint',failureOptions));
    return response.body;
  },
};