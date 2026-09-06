import { db as hatchableDb } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { invocationReconnectFor, statusForInvocationReconnectError } from 'lib/invocation-reconnect.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor=semanticCommandDescriptor('invocation.attach');
export const access='admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx){
    const db=ctx?.db || hatchableDb;
    const response=await executeCorrelatedCommand('invocation.attach',args||{},(input)=>invocationReconnectFor({db}).attach(input),{
      statusForFailure:statusForInvocationReconnectError,
      defaultError:'INVOCATION_ATTACH_ERROR',
      defaultMessage:'invocation.attach failed',
      flattenDetails:true,
      db,
    });
    return response.body;
  },
};