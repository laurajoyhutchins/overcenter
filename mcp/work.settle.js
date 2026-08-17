import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';

export default {
  name: 'work.settle',
  description: 'Consume one valid work lease and settle it as completed, requeue, or blocked with semantic Linear execution fencing. Optional run_id is orchestration metadata and is excluded from the settlement semantic request hash.',
  inputSchema: {
    type: 'object', required: ['lease_token','disposition','idempotency_key'],
    properties: {
      lease_token: { type: 'string' }, disposition: { type: 'string', enum: ['completed','requeue','blocked'] },
      evidence: { type: 'array', items: { type: 'object', required: ['kind','ref'], properties: { kind: { type: 'string' }, ref: { type: 'string' } } } },
      reason: { type: ['string','null'] }, promotion_condition: { type: ['string','null'] },
      next_state: { type: ['string','null'] }, next_lane: { type: ['string','null'] },
      idempotency_key: { type: 'string' }, run_id: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'work.settle',
      args || {},
      (input) => createPostgresWorkLeaseService().settle(input),
      {
        statusForFailure: statusForWorkLeaseError,
        defaultError: 'WORK_SETTLE_ERROR',
        defaultMessage: 'work.settle failed',
        flattenDetails: true,
        db: ctx?.db,
      },
    );
    return response.body;
  },
};