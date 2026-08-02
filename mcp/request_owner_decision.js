import { createPostgresWorkService } from 'lib/work-service.js';

export const access = 'admin';

export default {
  name: 'request_owner_decision',
  description: 'Use this only when work has reached a genuine owner authority boundary that cannot be inferred or delegated. It revision-checks the item and records one explicit unresolved decision with a recommended action.',
  inputSchema: {
    type: 'object',
    required: ['entityKey', 'expectedRevision', 'idempotencyKey', 'category', 'summary', 'recommendedAction'],
    properties: {
      entityKey: { type: 'string', minLength: 1, maxLength: 512 },
      expectedRevision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 400 },
      category: { type: 'string', minLength: 1, maxLength: 128 },
      summary: { type: 'string', minLength: 1, maxLength: 4000 },
      recommendedAction: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    return await createPostgresWorkService(ctx.db).requestOwnerDecision(args || {});
  },
};