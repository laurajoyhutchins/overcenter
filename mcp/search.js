import { createPostgresWorkService } from 'lib/work-service.js';

export const access = 'admin';

export default {
  name: 'search',
  description: 'Use this when you need to locate portfolio work, repositories, LORE findings, Deciduous context, blockers, or owner decisions before fetching one exact entity.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 512 },
      repository: { type: 'string', maxLength: 512 },
      lifecycle: {
        type: 'string',
        enum: ['backlog', 'ready', 'in_progress', 'blocked', 'awaiting_owner', 'awaiting_verification', 'completed', 'canceled'],
      },
      route: { type: 'string', maxLength: 128 },
      sourceType: { type: 'string', enum: ['portfolio', 'lore', 'deciduous', 'github', 'hatchable', 'linear'] },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
  },
  async handler(args, ctx) {
    return await createPostgresWorkService(ctx.db).search(args || {});
  },
};