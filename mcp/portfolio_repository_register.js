import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresRepositoryLifecycleService, statusForRepositoryDispositionError } from 'lib/repository-disposition.js';

export const access = 'admin';

export default {
  name: 'portfolio_repository_register',
  description: 'Register one GitHub repository into canonical Overcenter repository identity and lifecycle state. A newly observed unarchived repository enters DORMANT and cannot execute ordinary work until an explicit lifecycle transition energizes it.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['repository'],
    properties: {
      repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
      run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'portfolio.repository_register',
      args || {},
      (input) => createPostgresRepositoryLifecycleService({ db: ctx?.db }).register(input),
      { statusForFailure: statusForRepositoryDispositionError, flattenDetails: true, db: ctx?.db },
    );
    return response.body;
  },
};