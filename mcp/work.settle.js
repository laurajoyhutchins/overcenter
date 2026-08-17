import { executeCommand } from 'lib/command-response.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';

export default {
  name: 'work.settle',
  description: 'Consume one valid work lease and settle it as completed, requeue, or blocked with optimistic Linear state validation.',
  inputSchema: {
    type: 'object', required: ['lease_token','disposition','idempotency_key'],
    properties: {
      lease_token: { type: 'string' }, disposition: { type: 'string', enum: ['completed','requeue','blocked'] },
      evidence: { type: 'array', items: { type: 'object', required: ['kind','ref'], properties: { kind: { type: 'string' }, ref: { type: 'string' } } } },
      reason: { type: ['string','null'] }, promotion_condition: { type: ['string','null'] },
      next_state: { type: ['string','null'] }, next_lane: { type: ['string','null'] },
      idempotency_key: { type: 'string' },
    },
  },
  async handler(args) {
    const response = await executeCommand(
      'work.settle',
      () => createPostgresWorkLeaseService().settle(args || {}),
      {
        statusForFailure: statusForWorkLeaseError,
        defaultError: 'WORK_SETTLE_ERROR',
        defaultMessage: 'work.settle failed',
        flattenDetails: true,
      },
    );
    return response.body;
  },
};