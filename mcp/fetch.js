import { createPostgresWorkService } from 'lib/work-service.js';

export const access = 'admin';

export default {
  name: 'fetch',
  description: 'Use this after search, or when you already know an entity key, to retrieve one exact unified portfolio projection with LORE, Deciduous, GitHub, execution, blockers, revision, and next action.',
  inputSchema: {
    type: 'object',
    required: ['entityKey'],
    properties: {
      entityKey: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    return await createPostgresWorkService(ctx.db).fetch(args || {});
  },
};