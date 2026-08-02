import { createPostgresWorkService } from 'lib/work-service.js';

export const access = 'admin';

export default {
  name: 'get_next_work',
  description: 'Use this at the start or resumption of an engineering session to select one deterministic eligible assignment and receive its complete bounded LORE, Deciduous, GitHub, execution, authority, acceptance, and revision context.',
  inputSchema: {
    type: 'object',
    properties: {
      route: { type: 'string', maxLength: 128 },
      repository: { type: 'string', maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    return await createPostgresWorkService(ctx.db).getNextWork(args || {});
  },
};