import { createPostgresWorkLeaseService } from 'lib/work-leases.js';

export const access = 'admin';

export default {
  name: 'work.claim',
  description: 'Acquire a bounded exclusive lease for one already-selected Portfolio Orchestration issue and move it into its configured active lifecycle state. Does not select or rank work.',
  inputSchema: {
    type: 'object', required: ['work_ref','run_id','idempotency_key'],
    properties: {
      work_ref: { type: 'string' }, run_id: { type: 'string' }, expected_state: { type: 'string' },
      expected_lane: { type: 'string' }, lease_seconds: { type: 'integer', minimum: 60, maximum: 3600 },
      idempotency_key: { type: 'string' },
    },
  },
  async handler(args) { return createPostgresWorkLeaseService().claim(args || {}); },
};