import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { createPostgresWorkLeaseService, statusForWorkLeaseError } from 'lib/work-leases.js';

export const access = 'admin';

export default {
  name: 'work.claim',
  description: 'Acquire a bounded exclusive lease for one already-selected Portfolio Orchestration issue. The required run_id is both the existing claim-domain run identity and the orchestration correlation identity. Does not select or rank work.',
  inputSchema: {
    type: 'object', required: ['work_ref','run_id','idempotency_key'],
    properties: {
      work_ref: { type: 'string' }, run_id: { type: 'string', minLength: 1, maxLength: 512 }, expected_state: { type: 'string', description: 'Exact Linear lifecycle state just observed by the caller; normally Todo, or In Progress for a bounded recovery probe.' },
      expected_lane: { type: 'string', description: 'Exact execution lane just observed by the caller.' }, lease_seconds: { type: 'integer', minimum: 60, maximum: 3600 },
      idempotency_key: { type: 'string' },
    },
  },
  async handler(args, ctx) {
    const response = await executeCorrelatedCommand(
      'work.claim',
      args || {},
      (input) => createPostgresWorkLeaseService().claim(input),
      {
        statusForFailure: statusForWorkLeaseError,
        defaultError: 'WORK_CLAIM_ERROR',
        defaultMessage: 'work.claim failed',
        flattenDetails: true,
        db: ctx?.db,
      },
    );
    return response.body;
  },
};