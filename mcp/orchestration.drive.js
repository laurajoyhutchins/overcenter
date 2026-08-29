import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresOrchestrationDriveService, statusForOrchestrationDriveRuntimeError } from 'lib/orchestration-run-target-runtime.js';

export const access = 'admin';

export default {
  name:'orchestration.drive',
  description:'Drive one immutable targeted run across successive safely confirmed deterministic project transitions. The runtime owns the bounded advancement limit and reuses orchestration.advance for every transition. Stops at project completion, agent execution, WAITING/OFF_NOMINAL/BLOCKED state, authority change, indeterminate outcome, or the runtime advancement limit.',
  inputSchema:{
    type:'object',
    required:['run_id'],
    properties:{ run_id:{ type:'string', minLength:1, maxLength:512 } },
    additionalProperties:false,
  },
  async handler(args,ctx) {
    const response = await executeCorrelatedCommand(
      'orchestration.drive',
      args || {},
      (input) => createPostgresOrchestrationDriveService({ db:ctx?.db }).drive(input),
      {
        statusForFailure:statusForOrchestrationDriveRuntimeError,
        defaultError:'ORCHESTRATION_DRIVE_ERROR',
        defaultMessage:'orchestration.drive failed',
        flattenDetails:true,
        db:ctx?.db,
      },
    );
    return response.body;
  },
};
