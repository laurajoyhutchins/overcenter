import { db as hatchableDb } from 'hatchable';
import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { invocationReconnectFor, statusForInvocationReconnectError } from 'lib/invocation-reconnect.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor=semanticCommandDescriptor('invocation.peek');
export const access='admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args,ctx){
    const db=ctx?.db || hatchableDb;
    const response=await executeCorrelatedCommand('invocation.peek',args||{},(input)=>invocationReconnectFor({db}).peek(input),{
      statusForFailure:statusForInvocationReconnectError,
      defaultError:'INVOCATION_PEEK_ERROR',
      defaultMessage:'invocation.peek failed',
      flattenDetails:true,
      db,
    });
    return response.body;
  },
};