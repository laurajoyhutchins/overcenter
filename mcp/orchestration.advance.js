import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresOrchestrationAdvanceService, statusForOrchestrationAdvanceRuntimeError } from 'lib/orchestration-run-target-runtime.js';

export const access = 'admin';

export default {
  name:'orchestration.advance',
  description:'Advance one authoritative targeted project transition. Supply only the durable run_id. Overcenter rereads the immutable project target and current graph, deterministically handles occupied READY transitions, acquires exact transition authority, and either returns a bounded agent execution packet or confirms deterministic work. Caller-supplied graph, frontier, transition, lease, or lifecycle state is rejected.',
  inputSchema:{
    type:'object',
    required:['run_id'],
    properties:{ run_id:{ type:'string', minLength:1, maxLength:512 } },
    additionalProperties:false,
  },
  async handler(args,ctx) {
    const response = await executeCorrelatedCommand(
      'orchestration.advance',
      args || {},
      (input) => createPostgresOrchestrationAdvanceService({ db:ctx?.db }).advance(input),
      {
        statusForFailure:statusForOrchestrationAdvanceRuntimeError,
        defaultError:'ORCHESTRATION_ADVANCE_ERROR',
        defaultMessage:'orchestration.advance failed',
        flattenDetails:true,
        db:ctx?.db,
      },
    );
    return response.body;
  },
};
