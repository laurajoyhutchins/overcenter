import { verifyRepositoryRetirement } from 'lib/repository-disposal.js';

export const access = 'admin';

export default {
  name: 'portfolio_repository_status',
  description: 'Return canonical repository lifecycle and retirement verification state, including ordinary-work, Linear, scheduled-worker, Fast Forward, successor, and compatibility status.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['repository'],
    properties: {
      repository: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
    },
  },
  async handler(args, ctx) {
    return verifyRepositoryRetirement(args.repository, { db: ctx?.db });
  },
};