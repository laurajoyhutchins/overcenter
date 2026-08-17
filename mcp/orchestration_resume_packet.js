import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { orchestrationResumePacket } from 'lib/orchestration-recovery.js';

export const access = 'admin';

export default {
  name: 'orchestration_resume_packet',
  description: 'Reconstruct the smallest mechanically safe continuation state for one prior orchestration run. Read-only: it does not select or execute work.',
  inputSchema: {
    type: 'object',
    required: ['run_id'],
    properties: {
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'orchestration.resume_packet',
      args || {},
      (input) => orchestrationResumePacket(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};