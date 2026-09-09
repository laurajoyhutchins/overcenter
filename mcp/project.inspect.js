import { createHatchableGcpCommandAdapter } from 'lib/hatchable-gcp-command-adapter.js';
import { semanticCommandDescriptor } from 'lib/semantic-command-descriptors.js';

const descriptor = semanticCommandDescriptor('project.inspect');
const adapter = createHatchableGcpCommandAdapter();

export const access = 'admin';
export default {
  name:descriptor.mcp_name,
  description:descriptor.description,
  inputSchema:descriptor.input_schema,
  async handler(args) {
    return adapter.execute('project.inspect', args || {});
  },
};