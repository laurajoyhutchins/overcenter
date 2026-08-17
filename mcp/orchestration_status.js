import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { orchestrationStatus } from 'lib/orchestration-status.js';

export const access = 'admin';

export default {
  name: 'orchestration_status',
  description: 'Read a bounded operator-health projection for stranded or ambiguous orchestration state. This is observational and not durable work authority.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', minLength: 1, maxLength: 512, description: 'Optional run token to correlate this observation.' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'orchestration.status',
      args || {},
      () => orchestrationStatus({ db: ctx?.db }),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};