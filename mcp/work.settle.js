import { createPostgresWorkLeaseService } from 'lib/work-leases.js';

export const access = 'admin';

export default {
  name: 'work.settle',
  description: 'Consume one valid work lease and settle it as completed, requeue, or blocked with optimistic Linear state validation.',
  inputSchema: {
    type: 'object', required: ['lease_token','disposition','idempotency_key'],
    properties: {
      lease_token: { type: 'string' }, disposition: { type: 'string', enum: ['completed','requeue','blocked'] },
      evidence: { type: 'array', items: { type: 'object', required: ['kind','ref'], properties: { kind: { type: 'string' }, ref: { type: 'string' } } } },
      reason: { type: ['string','null'] }, promotion_condition: { type: ['string','null'] }, idempotency_key: { type: 'string' },
    },
  },
  async handler(args) { return createPostgresWorkLeaseService().settle(args || {}); },
};