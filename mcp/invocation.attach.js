import { db as hatchableDb } from 'hatchable';
import { invocationObservationFor } from 'lib/invocation-observation.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('invocation.attach');
export const access = 'admin';
export default {
  name: descriptor.mcp_name,
  description: descriptor.description,
  inputSchema: descriptor.input_schema,
  async handler(args, ctx) {
    return invocationObservationFor(ctx?.db || hatchableDb).attach(args || {});
  },
};