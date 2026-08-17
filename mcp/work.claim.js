import { createPostgresWorkLeaseService } from 'lib/work-leases.js';

export const access = 'admin';

export default {
  name: 'work.claim',
  description: 'Acquire a bounded exclusive lease for one already-selected Portfolio Orchestration issue. The optional expected_state and expected_lane are optimistic preconditions from a fresh authoritative read; expected_state may be In Progress for a bounded recovery probe, letting Hatchable safely reconcile an expired lease or orphaned transient state before acquiring the successor lease. Does not select or rank work.',
  inputSchema: {
    type: 'object', required: ['work_ref','run_id','idempotency_key'],
    properties: {
      work_ref: { type: 'string' }, run_id: { type: 'string' }, expected_state: { type: 'string', description: 'Exact Linear lifecycle state just observed by the caller; normally Todo, or In Progress for a bounded recovery probe.' },
      expected_lane: { type: 'string', description: 'Exact execution lane just observed by the caller.' }, lease_seconds: { type: 'integer', minimum: 60, maximum: 3600 },
      idempotency_key: { type: 'string' },
    },
  },
  async handler(args) { return createPostgresWorkLeaseService().claim(args || {}); },
};