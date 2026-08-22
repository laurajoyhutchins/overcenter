import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresRepositoryLifecycleService } from 'lib/repository-disposition.js';

export const access = 'admin';

export default {
  name: 'portfolio_repository_transition',
  description: 'Perform an explicit repository lifecycle transition. Reactivation is refused while GitHub remains archived and never occurs from external unarchive alone.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['repository', 'disposition', 'expected_disposition', 'reason'],
    properties: {
      repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      disposition: { type: 'string', enum: ['ACTIVE', 'MAINTENANCE', 'DORMANT', 'ARCHIVED', 'SUPERSEDED'] },
      expected_disposition: { type: 'string', enum: ['ACTIVE', 'MAINTENANCE', 'DORMANT', 'ARCHIVED', 'SUPERSEDED'] },
      reason: { type: 'string', minLength: 1, maxLength: 500 },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'portfolio.repository_transition',
      args || {},
      (input) => createPostgresRepositoryLifecycleService({ db: ctx?.db }).transition(input),
      { flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};