import { createPostgresWorkService } from 'lib/work-service.js';

export const access = 'admin';

export default {
  name: 'record_work_outcome',
  description: 'Use this once a bounded work attempt reaches a completed, blocked, pivoted, no-change, or handed-off outcome. It revision-checks the work item and atomically records the portfolio transition plus optional Deciduous outcome and LORE proposal.',
  inputSchema: {
    type: 'object',
    required: ['entityKey', 'expectedRevision', 'idempotencyKey', 'disposition', 'summary'],
    properties: {
      entityKey: { type: 'string', minLength: 1, maxLength: 512 },
      expectedRevision: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      idempotencyKey: { type: 'string', minLength: 1, maxLength: 400 },
      disposition: {
        type: 'string',
        enum: ['completed', 'blocked', 'pivoted', 'no_change', 'handed_off'],
      },
      summary: { type: 'string', minLength: 1, maxLength: 4000 },
      evidence: {
        type: 'array',
        maxItems: 50,
        items: { type: 'string', minLength: 1, maxLength: 512 },
      },
      deciduousOutcome: {
        type: 'object',
        required: ['outcomeId', 'summary'],
        properties: {
          outcomeId: { type: 'string', minLength: 1, maxLength: 256 },
          status: { type: 'string', maxLength: 64 },
          summary: { type: 'string', minLength: 1, maxLength: 4000 },
          evidence: {
            type: 'array',
            maxItems: 50,
            items: { type: 'string', minLength: 1, maxLength: 512 },
          },
        },
        additionalProperties: false,
      },
      loreProposal: {
        type: 'object',
        required: ['proposalId', 'title', 'summary'],
        properties: {
          proposalId: { type: 'string', minLength: 1, maxLength: 256 },
          title: { type: 'string', minLength: 1, maxLength: 512 },
          summary: { type: 'string', minLength: 1, maxLength: 4000 },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    return await createPostgresWorkService(ctx.db).recordWorkOutcome(args || {});
  },
};