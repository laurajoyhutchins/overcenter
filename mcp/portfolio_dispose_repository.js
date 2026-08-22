import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { disposeRepository } from 'lib/repository-disposal.js';

export const access = 'admin';

export default {
  name: 'portfolio_dispose_repository',
  description: 'Deterministically retire an archived or superseded repository from ordinary portfolio execution while preserving GitHub and Linear history.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['repository'],
    properties: {
      repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      disposition: { type: 'string', enum: ['ARCHIVED', 'SUPERSEDED'] },
      successor_repository: { type: ['string', 'null'], pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'portfolio.dispose_repository',
      args || {},
      (input) => disposeRepository(input, { db: ctx?.db }),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};